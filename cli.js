#!/usr/bin/env node

const FsExtra = require('fs-extra');
const readFileAsync = require('util').promisify(require('fs').readFile);
const Path = require('path');
const stripJsonComments = require('strip-json-comments');

const Packer = require('./lib/packer');
const Unpacker = require('./lib/unpacker');

/* eslint-disable no-console */

const cliArgs = require('commander')
    .version(require('./package.json').version)
    .option('-p, --pack     <path.json>', 'The package config file to pack')
    .option('-u, --unpack   <path.json>', 'The package config file to unpack')
    .option('-b, --base     <path>', 'The base folder on which to run the packaging')
    .option('-o, --out      <path>', 'Output folder where to put the results (when packing only- will be emptied and created)')
    .option('    --git-from <commit>', 'Base commit to diff from (Defaults to `latest`)')
    .option('    --git-to   <commit>', 'Target commit to diff to (Defaults to `head`')
    .parse(process.argv);

if (!cliArgs.gitFrom)
    cliArgs.gitFrom = 'latest';

if (!cliArgs.gitTo)
    cliArgs.gitTo = 'HEAD';

if ((!!cliArgs.pack === !!cliArgs.unpack) || // not specified or both specified
    (cliArgs.pack && (!cliArgs.base || !cliArgs.out)) || // missing opts for --pack
    (cliArgs.unpack && (!cliArgs.out))) { // missing opts for --unpack
    cliArgs.help();
    process.exit();
}

(async () => {

    if (cliArgs.pack) {
        try {
            let out = Path.resolve(cliArgs.out, './');

            await FsExtra.emptyDir(out);

            let json = JSON.parse(stripJsonComments(await readFileAsync(cliArgs.pack, { encoding: 'utf8' })));

            for (let packageDef of json) {
                console.log(`> Packaging ${packageDef['name']}...`);

                const packer = new Packer(packageDef['name']);
                packer.rootFolder = Path.resolve(cliArgs.base || process.cwd(), './');
                packer.variableDefs = packageDef['variables'];
                packer.actions = packageDef['actions'];
                packer.packageRules = packageDef['package'];
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
                    .on('duplicate_file', file => {
                        console.warn(
                            ` . Trying to add duplicate file ${file.name}:` +
                            `\n   Existing source: ${file.source} with size ${file.size}.` +
                            `\n   New source: ${file.newSource} with size ${file.newSize}.` +
                            `\n   Skipping...`
                        );
                    })
                    .on('warning', warning => {
                        console.warn(warning);
                    });

                await packer.run(out);
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

            let json = JSON.parse(stripJsonComments(await readFileAsync(inputConfig, { encoding: 'utf8' })));

            let unpacker = new Unpacker();
            unpacker.rules = json;
            unpacker.zipFilePath = Path.join(
                Path.dirname(inputConfig),
                Path.basename(inputConfig, Path.extname(inputConfig)) + '.zip'
            );
            await unpacker.run(out);
        }
        catch (err) {
            console.error('Failed: ' + err.stack.split('\n').join('        \n'));
            process.exit(1);
        }
    }

})();