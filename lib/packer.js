import Fs from 'fs';
import EventEmitter from 'events';
import Path from 'path';
import { spawn } from 'child_process';
import minimatch from 'minimatch';
import recursiveReaddir from 'recursive-readdir';
import Archiver from 'archiver';
import Tmp from 'tmp';
import someAsync from '../utils/someAsync.js';
import everyAsync from '../utils/everyAsync.js';
import GitUtil from '../utils/git.js';
import MsbuildUtil from '../utils/msbuild.js';
import XmlUtil from '../utils/xml.js';
import DotnetUtil from '../utils/dotnet.js';

const GitDiffStatus = GitUtil.GitDiffStatus;
const hasOwnProperty = Object.prototype.hasOwnProperty;
const OriginalModeSymbol = Symbol('original_mode');

/**
 * @typedef {Object} PackageVariablesDefinition
 * @property {{ pattern: string }=} git_diff
 * @property {string|string[]=} exclude
 */

/**
 * @typedef {string|PackageConditionalObject} PackageConditional
 */

/**
 * @typedef {Object} PackageConditionalObject
 * @property {PackageConditional[]=} and
 * @property {PackageConditional[]=} or
 * @property {boolean=} negate
 */

/**
 * @typedef {Object} PackageActionCmdOptions
 * @property {string} path
 * @property {string[]=} args
 * @property {string=} cwd
 * @property {boolean=} verbose
 * @property {number|null} [expectExitCode=0]
 */

/**
 * @typedef {Object} PackageActionMSBuildOptions
 * @property {string} solution
 * @property {string} target
 * @property {Object<string, string>} props
 * @property {boolean=} verbose
 */

/**
 * @typedef {Object} PackageActionDevenvOptions
 * @property {string} solution
 * @property {'Build'|'Clean'|'Deploy'|'Rebuild'} action
 * @property {string=} configuration
 * @property {string=} project
 * @property {string=} projectConfiguration
 * @property {boolean=} verbose
 */

/**
 * @typedef {Object} PackageActionDotnetCommand
 * @property {string} command
 * @property {string[]=} args
 * @property {Object<string, string>} props
 * @property {boolean=} verbose
 */

/**
 * @typedef {Object} PackageActionDefinition
 * @property {'cmd'|'msbuild'|'devenv'|'dotnet'} type
 * @property {PackageConditional=} condition
 * @property {string=} description
 * @property {PackageActionCmdOptions|PackageActionMSBuildOptions|PackageActionDevenvOptions|PackageActionDotnetCommand} options
 */

/**
 * @typedef {Object} PackageRuleDefinition
 * @property {PackageConditional=} condition
 * @property {string} source
 * @property {string} dest
 * @property {string=} pattern
 * @property {{path: string, args: string[]=, cwd: string=}|{path: string, args: string[]=, cwd: string=}[]=} command
 * @property {string=} sourceXmlPath
 * @property {string=} destXmlPath
 * @property {string|string[]=} exclude
 * @property {string|string[]=} excludeInPackage - useful to separate the exclusion in the unpack and the pack stage (defaults to `exclude`)
 * @property {'git_diff'|'sync'|'partial_sync'|'xml_replace'|'xml_insert'|'cmd'} mode
 * @property {boolean=} ignoreDuplicates
 */

/**
 * @typedef {object} NormalizedGitDiffItem
 * @property {GitDiffStatus} status
 * @property {number=} accuracy
 * @property {string} fullPath
 * @property {string} fullToPath
 * @property {string=} path
 * @property {string=} toPath
 */

/**
 * @fire Packer#action
 * @fire Packer#action_skip
 * @fire Packer#action_start
 * @fire Packer#pack_start
 * @fire Packer#pack_end
 * @fire Packer#duplicate_file
 * @fire Packer#warning
 */
class Packer extends EventEmitter {

    constructor(/** string */name) {
        super();

        this.state = {
            name: name,

            /** @type Object<string, PackageVariablesDefinition> */
            variableDefs: {},

            /** @type PackageActionDefinition[] */
            actions: [],

            /** @type PackageRuleDefinition[] */
            packageRules: [],

            rootFolder: '',

            gitChanges: null,
            variables: {},

            gitBase: 'HEAD',
            gitTarget: 'HEAD',

            caseInsensitiveDev: new Map(),
        };
    }

    /**
     * @param {PackageConditional} condition
     * @param {Object<string, *>} variables
     * @returns {boolean}
     * */
    async _validateCondition(condition, variables) {
        if (typeof condition === 'boolean' || typeof condition === 'number')
            return !!condition;

        if (typeof condition === 'string') {
            let negate = false;
            while (condition.startsWith('!'))
                negate = !negate;

            return !!(negate - (hasOwnProperty.call(variables, condition) && !!variables[condition]));
        }

        if (typeof condition === 'object' && condition) {
            const negate = hasOwnProperty.call(condition, 'negate') && !!condition['negate'];

            if (hasOwnProperty.call(condition, 'and') && Array.isArray(condition['and']))
                return !!(negate - await everyAsync(condition['and'], x => this._validateCondition(x, variables)));

            if (hasOwnProperty.call(condition, 'or') && Array.isArray(condition['or']))
                return !!(negate - await someAsync(condition['or'], x => this._validateCondition(x, variables)));

            if (hasOwnProperty.call(condition, 'git_diff')) {
                let changes = await this._getGitChanges(condition['git_diff']['pattern'], condition['git_diff']['exclude']);

                return changes.length > 0;
            }
        }

        return false;
    }

    _isPathCaseInsensitive(path) {
        let stat1, stat2;

        try {
            stat1 = Fs.statSync(path);
        } catch (ex) {
            return null;
        }

        if (this.state.caseInsensitiveDev.has(stat1.dev))
            return this.state.caseInsensitiveDev.get(stat1.dev);

        let sensitive = false;

        try {
            let path2 = path.toLowerCase();

            if (path2 === path)
                path2 = path.toUpperCase();

            if (path2 === path)
                return true;

            stat2 = Fs.statSync(path2);

            // Different file on similar path
            sensitive = stat1.ino !== stat2.ino;
        } catch (ex) {
            // File not found, we are case sensitive
            // Note: If the file was deleted, then there's a race condition and it may be detected as case sensitive
            sensitive = true;
        }

        this.state.caseInsensitiveDev.set(stat1.dev, sensitive);

        return sensitive;
    }

    /** @returns {string} */
    get name() {
        return this.state.name;
    }

    set name(/** string */name) {
        this.state.name = name;
    }

    /** @returns {Object<string, PackageVariablesDefinition>} */
    get variableDefs() {
        return this.state.variableDefs;
    }

    set variableDefs(/**Object<string, PackageVariablesDefinition>*/defs) {
        this.state.variableDefs = defs;
    }

    /** @returns {PackageActionDefinition[]} */
    get actions() {
        return this.state.actions;
    }

    set actions(/**PackageActionDefinition[]*/actions) {
        this.state.actions = actions;
    }

    /** @returns PackageRuleDefinition[] */
    get packageRules() {
        return this.state.packageRules;
    }

    set packageRules(/**PackageRuleDefinition[]*/rules) {
        this.state.packageRules = rules;
    }

    /** @returns string */
    get rootFolder() {
        return this.state.rootFolder;
    }

    set rootFolder(/**string*/folder) {
        if (this.state.rootFolder === folder) return;
        this.state.rootFolder = folder;
        this.state.gitChanges = null;
    }

    /** @returns string */
    get gitBaseCommit() {
        return this.state.gitBase;
    }

    set gitBaseCommit(/**string*/commit) {
        if (this.state.gitBase === commit) return;
        this.state.gitBase = commit;
        this.state.gitChanges = null;
    }

    /** @returns string */
    get gitTargetCommit() {
        return this.state.gitTarget;
    }

    set gitTargetCommit(/**string*/commit) {
        if (this.state.gitTarget === commit) return;
        this.state.gitTarget = commit;
        this.state.gitChanges = null;
    }

    /**
     *
     * @returns {NormalizedGitDiffItem[]}
     */
    async _getGitChanges(/** string? */pattern, /** string|string[]? */exclude, /** string? */sourceBase, /** boolean? */stripBase = false) {
        if (!this.state.gitChanges) {
            this.state.gitChanges = await GitUtil.fetchGitDiffList(
                this.state.gitBase,
                this.state.gitTarget,
                this.state.rootFolder,
            );
        }

        let changes = this.state.gitChanges.map(x => {
            x.path = Path.normalize(x.path);

            if (x.toPath)
                x.toPath = Path.normalize(x.toPath);

            return x;
        });

        if (pattern !== undefined) {

            if (pattern[0] !== '/' && pattern[0] !== '\\')
                pattern = '/' + pattern;

            const base = Path.join(sourceBase || '', '/').replace(/^\.?[/\\]/, '');
            const baseLower = base.toLowerCase();

            const filter = minimatch.filter(pattern, { nocase: true });
            const normalizedFilter = path => {
                if (base.length > 0) {
                    let sensitive = this._isPathCaseInsensitive(Path.join(this.state.rootFolder, path));

                    if (!(sensitive ? path : path.toLowerCase()).startsWith(sensitive ? base : baseLower))
                        return false;

                    path = path.substr(base.length);
                }

                if (path[0] !== '/' && path[0] !== '\\')
                    path = '/' + path;

                return filter(path);
            };

            changes = changes.filter(x => {
                if (normalizedFilter(x.path))
                    return true;

                if (x.toPath && normalizedFilter(x.toPath)) return true;

                return false;
            });

            if (stripBase) {
                changes = changes.map(x => {
                    let item = {
                        status: x.status,
                        fullPath: x.path,
                    };

                    let sensitive = this._isPathCaseInsensitive(Path.join(this.state.rootFolder, x.path));

                    if ((sensitive ? x.path : x.path.toLowerCase()).startsWith(sensitive ? base : baseLower))
                        item.path = x.path.substr(base.length);

                    if (hasOwnProperty.call(x, 'toPath')) {
                        item.fullToPath = x.toPath;
                        item.accuracy = x.accuracy;

                        let sensitive = this._isPathCaseInsensitive(Path.join(this.state.rootFolder, x.path));

                        if ((sensitive ? x.toPath : x.toPath.toLowerCase()).startsWith(sensitive ? base : baseLower))
                            item.toPath = x.toPath.substr(base.length);
                    }

                    return item;
                });
            }
        }

		if (typeof exclude === 'string' || (Array.isArray(exclude) && exclude.length)) {
			const filters = [].concat(exclude)
				.map(x => x.startsWith('/') ? x : `/${x}`)
				.map(x => minimatch.filter(x, { nocase: true }));
			const filter = (path) => filters.some(f => f(path));

			changes = changes.filter(x => {
				if (typeof x.path === 'string' && filter(/^[/\\]/.test(x.path) ? x.path : ('/' + x.path)))
					return false;
				if (typeof x.toPath === 'string' && filter(/^[/\\]/.test(x.toPath) ? x.toPath : ('/' + x.toPath)))
					return false;
				return true;
			});
		}

        return changes;
    }

    /**
     * @param {Object<string, PackageVariablesDefinition>} defs
     */
    async _determineVariables(defs) {
        let variables = {};

        for (let key of Object.keys(defs)) {
            let def = defs[key];
            const type = typeof def;

            if (type === 'object' && def !== null) {
                variables[key] = await this._validateCondition(def, variables);
            }
            else if (type === 'boolean' ||
                type === 'string' ||
                type === 'number') {
                variables[key] = def;
            }
            else {
                variables[key] = undefined;
            }
        }

        return variables;
    }

    /**
     * @param {PackageActionDefinition[]} actions
     * @param {Object<string, *>} variables
     */
    async _performActions(actions, variables) {
        for (let action of actions) {

            /**
             * Information about an action about to be taken
             * @event Packer#action
             * @type {PackageActionDefinition}
             */
            this.emit('action', action);

            if (hasOwnProperty.call(action, 'condition') &&
                !await this._validateCondition(action['condition'], variables)) {
                /**
                 * Information about a skipped action
                 * @event Packer#action_skip
                 * @type {PackageActionDefinition}
                 */
                this.emit('action_skip', action);
                continue;
            }

            /**
             * Information about an action that's actually going to start now
             * @event Packer#action_start
             * @type {PackageActionDefinition}
             */
            this.emit('action_start', action);

            let options = action.options;

            switch (action.type) {
                case 'msbuild': {
                    await MsbuildUtil.runMsbulid({ ...options, cwd: this.state.rootFolder });
                    break;
                }

                case 'devenv': {
                    await MsbuildUtil.runDevenv({ ...options, cwd: this.state.rootFolder });
                    break;
                }

                case 'dotnet': {
                    await DotnetUtil.runDotnet({ ...options, cwd: this.state.rootFolder });
                    break;
                }

                case 'cmd': {
                    await new Promise((resolve, reject) => {
                        let subp = spawn(
                            options['path'].replace(/%([^%]+)%/g, (_, v) => process.env[v]),
                            [].concat(options['args'] || []),
                            {
                                cwd: options['cwd'] || this.state.rootFolder || undefined,
                                shell: true,
                            },
                        );

                        let expectedExitCode = options['expectExitCode'];
                        if (typeof expectedExitCode !== 'number' && expectedExitCode !== null)
                            expectedExitCode = 0;

                        let stderr = [];
                        subp.stderr.on('data', data => stderr.push(data));

                        subp.on('error', err => {
                            if (stderr.length)
                                err.message += '\n' + Buffer.concat(stderr).toString('utf8');

                            reject(err);
                        });

                        subp.on('exit', (exitCode) => {
                            if (expectedExitCode !== null && exitCode !== expectedExitCode)
                                return reject(
                                    stderr.length
                                        ? new Error(Buffer.concat(stderr).toString('utf8'))
                                        : new Error(`Exited with code: ${exitCode}`),
                                );
                            resolve();
                        });

                        if (options['verbose']) {
                            subp.stdout.on('data', data => process.stdout.write(data));
                            subp.stderr.on('data', data => process.stderr.write(data));
                        }
                    });

                    break;
                }

                default:
                    throw new Error('Unsupported action type ' + action['type']);
            }
        }
    }

    /**
     * @param {PackageRuleDefinition[]} rules
     * @param {Object<string, *>} variables
     * @param {string} outputFolder
     */
    async _performPackage(rules, variables, outputFolder) {
        /**
         * Packing started event
         * @event Packer#pack_start
         * @type {void}
         */
        this.emit('pack_start');

        const tmpName = Tmp.fileSync({ discardDescriptor: true }).name;
        const outputStream = Fs.createWriteStream(tmpName);

        const archive = Archiver('zip', {
            forceLocalTime: true,
            zlib: { level: 9 },
        });

        /**@type UnpackRule[]*/
        const unpackRules = [];

        let archivedFiles = new Map();

        const addFileToArchive = (source, dest, ignoreDuplicates = false) => {
            let size = Fs.statSync(source).size;
            if (archivedFiles.has(dest)) {
                if (!ignoreDuplicates) {
                    let existing = archivedFiles.get(dest);

                    /**
                     * Information about a duplicate file selected for packing
                     * @event Packer#duplicate_file
                     * @type {Object}
                     * @property {string} name
                     * @property {string} source
                     * @property {number} size
                     * @property {string} newSource
                     * @property {number} newSize
                     */
                    this.emit('duplicate_file', {
                        name: dest,
                        source: source,
                        size: existing.size,
                        newSource: source,
                        newSize: size,
                    });
                }
                return;
            }

            archive.file(source, { name: dest });
            archivedFiles.set(dest, { source: source, size: size });
        };

        try {
            let resolve = null, reject = null,
                promise = new Promise((r, j) => { resolve = r; reject = j; });

            try {
                outputStream.on('close', resolve);

                archive.on('warning', reject);
                archive.on('error', reject);
                archive.pipe(outputStream);

                for (let rule of rules) {
                    if (hasOwnProperty.call(rule, 'condition') &&
                        !await this._validateCondition(rule.condition, variables))
                        continue;

                    let sourceBase = rule.source || './';
                    let destBase = rule.dest || '';
                    let mode = rule.mode;

                    switch (mode) {
                        case 'git_diff': {
                            let pattern = rule.pattern;
                            if (!pattern.startsWith('/'))
                                pattern = '/' + pattern;

							let excludePack = rule.excludeInPackage ?? rule.exclude;
                            let changes = await this._getGitChanges(pattern, excludePack, sourceBase, true);

                            for (let item of changes) {
                                switch (item.status) {
                                    case GitDiffStatus.ADDED:   // ADDED
                                    case GitDiffStatus.MODIFIED:   // MODIFIED
                                    case GitDiffStatus.TYPE_CHANGED: { // TYPE_CHANGED
                                        let destPath = Path.join(destBase, item.path);
                                        addFileToArchive(Path.join(this.state.rootFolder, item.fullPath), destPath, rule.ignoreDuplicates);
                                        unpackRules.push(/**@type UnpackRule_Copy*/{
                                            type: 'copy',
                                            path: destPath,
                                        });
                                        break;
                                    }

                                    case GitDiffStatus.COPIED: // COPIED
                                        if (hasOwnProperty.call(item, 'toPath')) {
                                            let destPath = Path.join(destBase, item.toPath);
                                            addFileToArchive(Path.join(this.state.rootFolder, item.fullToPath), destPath, rule.ignoreDuplicates);
                                            unpackRules.push(/**@type UnpackRule_Copy*/{
                                                type: 'copy',
                                                path: destPath,
                                            });
                                        }
                                        break;

                                    case GitDiffStatus.RENAMED: // RENAMED
                                        if (hasOwnProperty.call(item, 'toPath')) {
                                            let destPath = Path.join(destBase, item.toPath);
                                            addFileToArchive(Path.join(this.state.rootFolder, item.fullToPath), destPath, rule.ignoreDuplicates);

                                            unpackRules.push(/**@type UnpackRule_Copy*/{
                                                type: 'copy',
                                                path: destPath,
                                            });
                                        }

                                        if (hasOwnProperty.call(item, 'path')) {
                                            unpackRules.push(/**@type UnpackRule_Delete*/{
                                                type: 'delete',
                                                path: Path.join(destBase, item.path),
                                            });
                                        }

                                        break;

                                    case GitDiffStatus.DELETED: // DELETED
                                        unpackRules.push(/**@type UnpackRule_Delete*/{
                                            type: 'delete',
                                            path: Path.join(destBase, item.path),
                                        });
                                        break;

                                    default:
                                        /**
                                         * Warning
                                         * @event Packer#warning
                                         * @type {string}
                                         */
                                        this.emit('warning',
                                            `File ${item.path} has status ${item.status} in git.` +
                                            ` This means we don't know what to do with it`);
                                        break;
                                }
                            }

                        }
                        break;

                        case 'sync':
                        case 'partial_sync': {
                            let pattern = rule.pattern;
                            if (!pattern.startsWith('/'))
                                pattern = '/' + pattern;

                            const globRoot = Path.resolve(Path.join(this.state.rootFolder, sourceBase), './');
                            const filter = minimatch.filter(pattern, { nocase: true });
                            let files = await recursiveReaddir(globRoot);
                            files = files.map(x => x.substr(globRoot.length));
                            let matches = files.filter(filter);
							
							let excludePack = rule.excludeInPackage ?? rule.exclude;
							
                            if (typeof excludePack === 'string' || (Array.isArray(excludePack) && excludePack.length)) {
                                const filters = [].concat(excludePack)
                                    .map(x => x.startsWith('/') ? x : `/${x}`)
                                    .map(x => minimatch.filter(x, { nocase: true }));
                                const filter = (path) => filters.some(f => f(path));

                                matches = matches.filter(x => {
                                    if (typeof x === 'string' && filter(/^[/\\]/.test(x) ? x : ('/' + x)))
                                        return false;
                                    return true;
                                });
                            }

                            for (let match of matches) {
                                addFileToArchive(
                                    Path.join(globRoot, match),
                                    Path.join(destBase, match),
                                    rule.ignoreDuplicates,
                                );
                            }

                            /**@type UnpackRule_Sync*/
                            let unpackRule = mode === 'partial_sync'
                                ? undefined
                                : unpackRules.find(x => x[OriginalModeSymbol] === mode && x.path === destBase);

                            if (unpackRule === undefined) {
                                unpackRule = {
                                    type: 'sync',
                                    [OriginalModeSymbol]: mode,
                                    path: destBase,
                                };

                                if (mode === 'partial_sync')
                                    unpackRule.exclude = ['!' + rule.pattern];

                                unpackRules.push(unpackRule);
                            }

                            if (typeof rule.exclude === 'string' || Array.isArray(rule.exclude)) {
                                unpackRule.exclude = (unpackRule.exclude || []).concat(rule.exclude);
                            }
                        }
                        break;

                        case 'xml_replace':
                        case 'xml_insert': {
                            const xmlFilePath = Path.resolve(Path.join(this.state.rootFolder, sourceBase), './');

                            let xmlTree = XmlUtil.parseXmlAtFile(xmlFilePath);
                            let node = XmlUtil.extractNode(xmlTree, rule.sourceXmlPath);

                            /**@type UnpackRule_Sync*/
                            let unpackRule = unpackRules.find(x => x.type === 'xml' && x.path === destBase);

                            if (unpackRule === undefined) {
                                unpackRule = {
                                    type: 'xml',
                                    path: destBase,
                                    actions: [],
                                };
                                unpackRules.push(unpackRule);
                            }

                            if (node === null) {
                                /**
                                 * Warning
                                 * @event Packer#warning
                                 * @type {string}
                                 */
                                this.emit('warning',
                                    `Xml at ${xmlFilePath} has no node at ${rule.sourceXmlPath}. It will be deleted in destination when unpacking.`);
                            }

                            if (node != null || mode === 'xml_replace') {
                                unpackRule.actions.push({
                                    mode: mode.replace(/^xml_/, ''),
                                    path: rule.destXmlPath,
                                    xml: node === null ? null : XmlUtil.stringify(node),
                                });
                            }
                        }
                        break;

                        case 'cmd': {
                            unpackRules.push({
                                type: mode,
                                commands: [].concat(rule.command),
                            });
                        }
                        break;

                        default:
                            throw new Error('Unsupported action');
                    }
                }

                archive.finalize();

            } catch (err) {
                reject(err);
            }

            await promise;
        } catch (err) {
            archive.abort();
            outputStream.close();
            Fs.unlink(tmpName, () => {});
            throw err;
        }

        let zipPath = Path.join(outputFolder, this.state.name + '.zip');
        let cfgPath = Path.join(outputFolder, this.state.name + '.json');

        await Fs.promises.copyFile(tmpName, zipPath);
        await Fs.promises.unlink(tmpName);
        await Fs.promises.writeFile(cfgPath, JSON.stringify(unpackRules), { encoding: 'utf8' });

        /**
         * Packing started event
         * @event Packer#pack_end
         * @type {void}
         */
        this.emit('pack_end');
    }

    async run(/**string*/outputFolder) {
        if (this.state.variableDefs)
            this.state.variables = await this._determineVariables(this.state.variableDefs);

        if (this.state.actions)
            await this._performActions(this.state.actions, this.state.variables || {});

        if (this.state.packageRules)
            await this._performPackage(this.state.packageRules, this.state.variables || {}, outputFolder);
    }
}

export default Packer;
