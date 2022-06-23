#!/usr/bin/env node

import Fs from 'fs';
import FsExtra from 'fs-extra';
import Path from 'path';
import stripJsonComments from 'strip-json-comments';
import Packer from './lib/packer.js';
import Unpacker from './lib/unpacker.js';
import { program as commanderProgram } from 'commander';
import { fileURLToPath } from 'url';

const __dirname = Path.dirname(fileURLToPath(import.meta.url));
const packageVersion = JSON.parse(stripJsonComments(Fs.readFileSync(Path.resolve(__dirname, './package.json'), { encoding: 'utf8' }))).version;

/* eslint-disable no-console */

commanderProgram
    .option('-p, --pack     <path.json>', 'The package config file to pack')
    .option('-u, --unpack   <path.json>', 'The package config file to unpack')
    .option('-b, --base     <path>', 'The base folder on which to run the packaging')
    .option('-o, --out      <path>', 'Output folder where to put the results (when packing only- will be emptied and created)')
    .option('    --git-from <commit>', 'Base commit to diff from (Defaults to `latest`)')
    .option('    --git-to   <commit>', 'Target commit to diff to (Defaults to `head`')
    .version(packageVersion);

const cliArgs = commanderProgram.parse(process.argv).opts();

if (!cliArgs.gitFrom)
    cliArgs.gitFrom = 'latest';

if (!cliArgs.gitTo)
    cliArgs.gitTo = 'HEAD';

if ((!!cliArgs.pack === !!cliArgs.unpack) || // not specified or both specified
    (cliArgs.pack && (!cliArgs.base || !cliArgs.out)) || // missing opts for --pack
    (cliArgs.unpack && (!cliArgs.out))) { // missing opts for --unpack
    commanderProgram.help();
    process.exit();
}

(async () => {

    if (cliArgs.pack) {
        try {
            let out = Path.resolve(cliArgs.out, './');

            await FsExtra.emptyDir(out);

            let json = JSON.parse(stripJsonComments(await Fs.promises.readFile(cliArgs.pack, { encoding: 'utf8' })));

            let executedOnce = new Set();
            let executing = new Set();
            let resolving = new Set();

            const resolvePackageDefOptions = packageDef => {
                if (resolving.has(packageDef)) {
                    console.error(`> Circular dependency on '${packageDef['name']}'.`);
                    throw new Error(`A circular dependency was found while trying to resolve package '${packageDef['name']}'`);
                }

                resolving.add(packageDef);

                try {
                    const imports = [].concat(packageDef['import'] ?? []);
                    const executeOncePackages = [];
                    const importedVariables = {};
                    const importedActions = [];
                    const importedPackageRules = [];

                    for (let importName of imports) {
                        const importedPackageDef = json.find(p => p.name === importName);
                        if (!importedPackageDef) {
                            console.warn(`  .. Imported '${importName}' in '${packageDef['name']}' was not found!`);
                            continue;
                        }

                        if (importedPackageDef['executeOnce']) {
                            executeOncePackages.push(importedPackageDef);
                            continue;
                        }

                        let resolved = resolvePackageDefOptions(importedPackageDef);
                        Object.assign(importedVariables, resolved.variables);
                        importedActions.push(...resolved.actions);
                        importedPackageRules.push(...resolved.packageRules);
                        executeOncePackages.push(...resolved.executeOncePackages);
                    }

                    const variables = { ...importedVariables, ...packageDef['variables'] };
                    const actions = importedActions.concat(packageDef['actions'] ?? []);
                    const packageRules = importedPackageRules.concat(packageDef['package'] ?? []);

                    return {
                        executeOncePackages: executeOncePackages,
                        variables: variables,
                        actions: actions,
                        packageRules: packageRules,
                    };
                } finally {
                    resolving.delete(packageDef);
                }
            };

            const executePackageDef = async packageDef => {
                if (executing.has(packageDef)) {
                    console.warn(`> Recursive execution of ${packageDef['name']}, breaking the loop.`);
                    return;
                }

                executing.add(packageDef);

                try {
                    const resolved = resolvePackageDefOptions(packageDef);

                    for (let executeOnceDef of resolved.executeOncePackages) {
                        if (executedOnce.has(packageDef['name']))
                            continue;

                        await executePackageDef(executeOnceDef);
                    }

                    console.log(`> Packaging ${packageDef['name']}...`);

                    const packer = new Packer(packageDef['name']);
                    packer.rootFolder = Path.resolve(cliArgs.base || process.cwd(), './');
                    packer.variableDefs = resolved.variables;
                    packer.actions = resolved.actions;
                    packer.packageRules = resolved.packageRules;
                    packer.gitBaseCommit = cliArgs.gitFrom;
                    packer.gitTargetCommit = cliArgs.gitTo;

                    packer
                        .on('action', /**PackageActionDefinition*/action => {
                            if (!action.description) return;

                            console.log('  . Action: ' + action.description);
                        })
                        .on('action_start', /**PackageActionDefinition*/action => {
                            if (!action.description) return;

                            switch (action['type']) {
                                case 'msbuild':
                                    console.log(`  .. Performing MSBuild of ${action.options.solution}...`);
                                    break;

                                case 'devenv':
                                    console.log(`  .. Performing Devenv of ${action.options.solution}...`);
                                    break;

                                case 'cmd':
                                    console.log(`  .. Performing command ${action.options.path} with args ${action.options.args.join(' ')}...`);
                                    break;
                            }
                        })
                        .on('action_skip', /**PackageActionDefinition*/action => {
                            if (!action.description) return;

                            console.log('  .. Skipped');
                        })
                        .on('pack_start', () => {
                            console.log(`  . Packing...`);
                        })
                        .on('pack_skip', () => {
                            console.log(`  . Skipped packing, due to zero packing rules.`);
                        })
                        .on('duplicate_file', file => {
                            console.warn(
                                ` . Trying to add duplicate file ${file.name}:` +
                                `\n   Existing source: ${file.source} with size ${file.size}.` +
                                `\n   New source: ${file.newSource} with size ${file.newSize}.` +
                                `\n   Skipping...`,
                            );
                        })
                        .on('warning', warning => {
                            console.warn(warning);
                        });

                    await packer.run(out);
                } finally {
                    executing.delete(packageDef);
                }
            };

            for (let packageDef of json) {
                if (packageDef['autoPack'] === false)
                    continue;

                await executePackageDef(packageDef);
            }

            console.log(`> Done.`);
        }
        catch (err) {
            console.error('Failed: ' + err.stack.split('\n').join('        \n'));
            process.exit(1);
        }
    }

    if (cliArgs.unpack) {
        try {
            let out = Path.resolve(cliArgs.out, './');

            await FsExtra.mkdirs(out);

            let inputConfig = cliArgs.unpack;
            if (!FsExtra.existsSync(inputConfig) && FsExtra.existsSync(inputConfig + '.json'))
                inputConfig = inputConfig + '.json';

            let json = JSON.parse(stripJsonComments(await Fs.promises.readFile(inputConfig, { encoding: 'utf8' })));

            let unpacker = new Unpacker();
            unpacker.rules = json;
            unpacker.zipFilePath = Path.join(
                Path.dirname(inputConfig),
                Path.basename(inputConfig, Path.extname(inputConfig)) + '.zip',
            );
            await unpacker.run(out);
        }
        catch (err) {
            console.error('Failed: ' + err.stack.split('\n').join('        \n'));
            process.exit(1);
        }
    }

})();
