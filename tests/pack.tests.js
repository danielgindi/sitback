const assert = require('assert');
const Path = require('path');
const execSync = require('child_process').execSync;
const FsExtra = require('fs-extra');
const AdmZip = require('adm-zip');
const recursiveReaddir = require('recursive-readdir');
const XmlUtil = require('../utils/xml');

const Packer = require('../lib/packer');
const Unpacker = require('../lib/unpacker');

describe('Packing / Unpacking', async () => {

    const workdir = Path.join(__dirname, 'workdir');
    const gitPath = Path.join(workdir, 'gitsource');
    const destPath = Path.join(workdir, 'dest');
    const unpackPath = Path.join(workdir, 'unpack');

    const getCurrentCommit = () => execSync('git rev-parse --verify HEAD', { cwd: gitPath }).toString().trim();
    const checkout = commit => execSync(`git checkout ${commit}`, { cwd: gitPath, stdio: 'ignore' });

    const COMMITS = {};

    beforeEach(async function() {
        this.timeout(5000);

        await FsExtra.emptyDir(workdir);
        await FsExtra.emptyDir(gitPath);
        await FsExtra.emptyDir(destPath);
        await FsExtra.emptyDir(unpackPath);

        execSync('git init', { cwd: gitPath });
        execSync('git commit -m "root commit" --allow-empty', { cwd: gitPath });
        COMMITS.empty = getCurrentCommit();

        await FsExtra.emptyDir(Path.join(gitPath, 'foo'));
        await FsExtra.emptyDir(Path.join(gitPath, 'bar'));

        await FsExtra.writeFile(Path.join(gitPath, 'foo/a.txt'), 'a');
        execSync('git add . && git commit -m "added foo/a"', { cwd: gitPath });
        COMMITS.addedFooA = getCurrentCommit();

        await FsExtra.writeFile(Path.join(gitPath, 'foo/b.txt'), 'b');
        execSync('git add . && git commit -m "added foo/b"', { cwd: gitPath });
        COMMITS.addedFooB = getCurrentCommit();

        await FsExtra.writeFile(Path.join(gitPath, 'foo/b.bin'), 'bin');
        execSync('git add . && git commit -m "added foo/b"', { cwd: gitPath });
        COMMITS.addedFooBbin = getCurrentCommit();

        await FsExtra.writeFile(Path.join(gitPath, 'foo/c.txt'), 'c');
        execSync('git add . && git commit -m "added foo/c"', { cwd: gitPath });
        COMMITS.addedFooC = getCurrentCommit();

        await FsExtra.writeFile(Path.join(gitPath, 'foo/b.txt'), 'b2');
        execSync('git add . && git commit -m "modified foo/b"', { cwd: gitPath });
        COMMITS.modifiedFooB = getCurrentCommit();

        await FsExtra.remove(Path.join(gitPath, 'foo/c.txt'));
        execSync('git add . && git commit -m "remove foo/c"', { cwd: gitPath });
        COMMITS.removedFooC = getCurrentCommit();

        await FsExtra.writeFile(Path.join(gitPath, 'bar/a.txt'), 'a');
        execSync('git add . && git commit -m "added bar/a"', { cwd: gitPath });
        COMMITS.addedBarA = getCurrentCommit();

        await FsExtra.writeFile(Path.join(gitPath, 'bar/b.txt'), 'b');
        execSync('git add . && git commit -m "added bar/b"', { cwd: gitPath });
        COMMITS.addedBarB = getCurrentCommit();

        await FsExtra.writeFile(Path.join(gitPath, 'bar/b.bin'), 'bin');
        execSync('git add . && git commit -m "added bar/b"', { cwd: gitPath });
        COMMITS.addedBarBbin = getCurrentCommit();

        await FsExtra.writeFile(Path.join(gitPath, 'foo/source.xml'), '<?xml version="1.0" encoding="utf-8"?><configuration><some></some><other attr="1"><item>value</item><item>value</item></other></configuration>');
        execSync('git add . && git commit -m "added foo/source.xml"', { cwd: gitPath });
        COMMITS.addedFooSourceXml = getCurrentCommit();
    });

    afterEach(async () => {
        await FsExtra.remove(workdir);
    });

    describe('Git diff', async () => {
        it('Start to end', async () => {

            let packer = new Packer('test');
            packer.rootFolder = gitPath;
            packer.variableDefs = {};
            packer.actions = [];
            packer.packageRules = [
                {
                    'source': './',
                    'dest': './',
                    'pattern': '**/*',
                    'mode': 'git_diff',
                },
            ];
            packer.gitBaseCommit = COMMITS.empty;
            packer.gitTargetCommit = COMMITS.addedBarBbin;

            await packer.run(destPath);

            let archiveEntries = new AdmZip(Path.join(destPath, 'test.zip')).getEntries().map(x => x.entryName).sort();
            let config = JSON.parse(FsExtra.readFileSync(Path.join(destPath, 'test.json'), { encoding: 'utf8' }));

            assert.strictEqual(archiveEntries.length, 6);
            assert.strictEqual(config.length, archiveEntries.length);
            assert.strictEqual(config.some(x => x.type !== 'copy'), false);
            assert.deepStrictEqual(config.map(x => x.path.replace(/\\/g, '/')), archiveEntries);
        }).slow('1s');

        it('Halfway', async () => {

            let packer = new Packer('test');
            packer.rootFolder = gitPath;
            packer.variableDefs = {};
            packer.actions = [];
            packer.packageRules = [
                {
                    'source': '/',
                    'dest': '/',
                    'pattern': '**/*',
                    'mode': 'git_diff',
                },
            ];
            packer.gitBaseCommit = COMMITS.addedFooBbin;
            packer.gitTargetCommit = COMMITS.addedBarA;

            await packer.run(destPath);

            let archiveEntries = new AdmZip(Path.join(destPath, 'test.zip')).getEntries().map(x => x.entryName).sort();
            let config = JSON.parse(FsExtra.readFileSync(Path.join(destPath, 'test.json'), { encoding: 'utf8' }));

            assert.strictEqual(archiveEntries.length, 2);
            assert.deepStrictEqual(['bar/a.txt', 'foo/b.txt'], archiveEntries);
            assert.deepStrictEqual([
                { 'type': 'copy', 'path': Path.normalize('/bar/a.txt') },
                { 'type': 'copy', 'path': Path.normalize('/foo/b.txt') },
            ], config);
        }).slow('1s');

        it('Exclusions', async () => {

            let packer = new Packer('test');
            packer.rootFolder = gitPath;
            packer.variableDefs = {};
            packer.actions = [];
            packer.packageRules = [
                {
                    'source': '/',
                    'dest': '/',
                    'pattern': '**/*',
                    'exclude': '**/*.bin',
                    'mode': 'git_diff',
                },
            ];
            packer.gitBaseCommit = COMMITS.empty;
            packer.gitTargetCommit = COMMITS.addedBarBbin;

            await packer.run(destPath);

            let config = JSON.parse(FsExtra.readFileSync(Path.join(destPath, 'test.json'), { encoding: 'utf8' }));

            assert.strictEqual(config.some(x => /\.bin$/.test(x.path)), false);
        }).slow('1s');

        it('Variables', async () => {

            let packer = new Packer('test');
            packer.rootFolder = gitPath;
            packer.variableDefs = {
                'has_bin_changes': {
                    'git_diff': { 'pattern': '**/*.bin' },
                },
            };
            packer.actions = [];
            packer.packageRules = [];
            packer.gitBaseCommit = COMMITS.empty;
            packer.gitTargetCommit = COMMITS.addedBarBbin;

            let variables = await packer._determineVariables(packer.variableDefs);
            assert.strictEqual(variables['has_bin_changes'], true);

            packer.gitBaseCommit = COMMITS.addedFooBbin;
            packer.gitTargetCommit = COMMITS.addedFooC;

            variables = await packer._determineVariables(packer.variableDefs);
            assert.strictEqual(variables['has_bin_changes'], false);

        }).slow('1s');

        it('Conditions', async () => {

            let packer = new Packer('test');
            packer.rootFolder = gitPath;
            packer.variableDefs = {
                'has_bin_changes': {
                    'git_diff': { 'pattern': '**/*.bin' },
                },
            };
            packer.actions = [];
            packer.packageRules = [
                {
                    'condition': 'has_bin_changes',
                    'source': './',
                    'dest': './',
                    'pattern': '**/*',
                    'mode': 'git_diff',
                },
            ];
            packer.gitBaseCommit = COMMITS.empty;
            packer.gitTargetCommit = COMMITS.addedBarBbin;

            await packer.run(destPath);

            let config = JSON.parse(FsExtra.readFileSync(Path.join(destPath, 'test.json'), { encoding: 'utf8' }));

            assert.ok(config.length > 0);

        }).slow('1s');
    });

    describe('Sync', async () => {

        it('All', async () => {

            let packer = new Packer('test');
            packer.rootFolder = gitPath;
            packer.variableDefs = {};
            packer.actions = [];
            packer.packageRules = [
                {
                    'source': './',
                    'dest': './',
                    'pattern': '**/*',
                    'mode': 'sync',
                },
            ];
            packer.gitBaseCommit = COMMITS.empty;
            packer.gitTargetCommit = COMMITS.addedFooSourceXml;

            await packer.run(destPath);

            let archiveEntries = new AdmZip(Path.join(destPath, 'test.zip')).getEntries().map(x => x.entryName).sort();
            let config = JSON.parse(FsExtra.readFileSync(Path.join(destPath, 'test.json'), { encoding: 'utf8' }));

            assert.strictEqual(archiveEntries.length, 7);
            assert.strictEqual(config.length, 1);
            assert.deepStrictEqual(config, [{ "type":"sync", "path":"./" }]);
        }).slow('1s');
        
        it('Subfolder', async () => {

            let packer = new Packer('test');
            packer.rootFolder = gitPath;
            packer.variableDefs = {};
            packer.actions = [];
            packer.packageRules = [
                {
                    'source': 'foo',
                    'dest': 'dest_foo',
                    'pattern': '**/*',
                    'mode': 'sync',
                },
            ];
            packer.gitBaseCommit = COMMITS.empty;
            packer.gitTargetCommit = COMMITS.addedFooSourceXml;

            await packer.run(destPath);

            let archiveEntries = new AdmZip(Path.join(destPath, 'test.zip')).getEntries().map(x => x.entryName).sort();
            let config = JSON.parse(FsExtra.readFileSync(Path.join(destPath, 'test.json'), { encoding: 'utf8' }));

            assert.strictEqual(archiveEntries.length, 4);
            assert.deepStrictEqual(config, [{ "type":"sync", "path":"dest_foo" }]);
        }).slow('1s');
        
    });

    describe('Xml', async () => {

        it('All', async () => {

            let packer = new Packer('test');
            packer.rootFolder = gitPath;
            packer.variableDefs = {};
            packer.actions = [];
            packer.packageRules = [
                {
                    'source': './foo/source.xml',
                    'dest': './dest.xml',
                    'sourceXmlPath': '$.configuration.other',
                    'destXmlPath': '$.configuration.other',
                    'mode': 'xml_replace',
                },
            ];
            packer.gitBaseCommit = COMMITS.addedBarBbin;
            packer.gitTargetCommit = COMMITS.addedFooSourceXml;

            await packer.run(destPath);

            // Create dest
            await FsExtra.writeFile(Path.join(unpackPath, 'dest.xml'), '<?xml version="1.0" encoding="utf-8"?><configuration><some>stuff</some><other some="stuff"><stuff>value</stuff></other></configuration>');

            // Unpack
            let config = JSON.parse(FsExtra.readFileSync(Path.join(destPath, 'test.json'), { encoding: 'utf8' }));

            let unpacker = new Unpacker();
            unpacker.rules = config;
            unpacker.zipFilePath = Path.join(destPath, 'test.zip');
            
            await unpacker.run(unpackPath);

            let xmlTree = XmlUtil.extractNode(
                XmlUtil.parseXmlAtFile(Path.join(unpackPath, 'dest.xml')));

            assert.deepStrictEqual(xmlTree, {
                'configuration': {
                    some: 'stuff',
                    other: {
                        item: [
                            'value',
                            'value',
                        ],
                        _Attribs: {
                            attr: '1',
                        },
                    },
                },
            });
        }).slow('1s');
        
    });

    describe('Unpack', async () => {

        it('Complete', async () => {

            let packer = new Packer('test');
            packer.rootFolder = gitPath;
            packer.variableDefs = {};
            packer.actions = [];
            packer.packageRules = [
                {
                    'source': './',
                    'dest': './',
                    'pattern': '**/*',
                    'mode': 'git_diff',
                },
            ];
            packer.gitBaseCommit = COMMITS.empty;
            packer.gitTargetCommit = COMMITS.addedFooSourceXml;

            await packer.run(destPath);

            let archiveEntries = new AdmZip(Path.join(destPath, 'test.zip')).getEntries().map(x => x.entryName).sort();
            let config = JSON.parse(FsExtra.readFileSync(Path.join(destPath, 'test.json'), { encoding: 'utf8' }));

            let unpacker = new Unpacker();
            unpacker.rules = config;
            unpacker.zipFilePath = Path.join(destPath, 'test.zip');

            await unpacker.run(unpackPath);
            
            let sourceFiles = (await recursiveReaddir(gitPath, ['.git'])).map(x => x.substr(gitPath.length)).sort();
            let unpackedFiles = (await recursiveReaddir(unpackPath)).map(x => x.substr(unpackPath.length)).sort();
            assert.deepStrictEqual(sourceFiles, unpackedFiles);
            assert.strictEqual(archiveEntries.length, unpackedFiles.length);

        }).slow('1s');

        it('Two stages sequence', async () => {

            // Pack half the commits
            let packer = new Packer('test');
            packer.rootFolder = gitPath;
            packer.variableDefs = {};
            packer.actions = [];
            packer.packageRules = [
                {
                    'source': './',
                    'dest': './',
                    'pattern': '**/*',
                    'mode': 'git_diff',
                },
            ];

            packer.gitBaseCommit = COMMITS.empty;
            packer.gitTargetCommit = 'HEAD';

            await checkout(COMMITS.modifiedFooB);
            await packer.run(destPath);

            // Unpack half the commits
            let config = JSON.parse(FsExtra.readFileSync(Path.join(destPath, 'test.json'), { encoding: 'utf8' }));

            let unpacker = new Unpacker();
            unpacker.rules = config;
            unpacker.zipFilePath = Path.join(destPath, 'test.zip');

            await unpacker.run(unpackPath);

            // Pack the other half
            packer = new Packer('test');
            packer.rootFolder = gitPath;
            packer.variableDefs = {};
            packer.actions = [];
            packer.packageRules = [
                {
                    'source': './',
                    'dest': './',
                    'pattern': '**/*',
                    'mode': 'git_diff',
                },
            ];

            packer.gitBaseCommit = await getCurrentCommit();
            packer.gitTargetCommit = 'HEAD';

            await checkout(COMMITS.addedBarBbin);
            await packer.run(destPath);

            // Unpack them
            config = JSON.parse(FsExtra.readFileSync(Path.join(destPath, 'test.json'), { encoding: 'utf8' }));

            unpacker = new Unpacker();
            unpacker.rules = config;
            unpacker.zipFilePath = Path.join(destPath, 'test.zip');

            await unpacker.run(unpackPath);
            
            let sourceFiles = (await recursiveReaddir(gitPath, ['.git'])).map(x => x.substr(gitPath.length)).sort();
            let unpackedFiles = (await recursiveReaddir(unpackPath)).map(x => x.substr(unpackPath.length)).sort();
            assert.deepStrictEqual(sourceFiles, unpackedFiles);

        }).slow('1s');

    });

});

describe('Conditions', async () => {

    it('and', async () => {

        let packer = new Packer('test');

        assert.strictEqual(await packer._validateCondition({ 'and': [true, false] }, {}), false);
        assert.strictEqual(await packer._validateCondition({ 'and': [true, true] }, {}), true);
        assert.strictEqual(await packer._validateCondition({ 'and': [false, true] }, {}), false);
        assert.strictEqual(await packer._validateCondition({ 'and': [false, false] }, {}), false);

    }).slow('1s');

    it('or', async () => {

        let packer = new Packer('test');

        assert.strictEqual(await packer._validateCondition({ 'or': [true, false] }, {}), true);
        assert.strictEqual(await packer._validateCondition({ 'or': [true, true] }, {}), true);
        assert.strictEqual(await packer._validateCondition({ 'or': [false, true] }, {}), true);
        assert.strictEqual(await packer._validateCondition({ 'or': [false, false] }, {}), false);

    }).slow('1s');

    it('with variables', async () => {

        let packer = new Packer('test');

        assert.strictEqual(await packer._validateCondition('a', { 'a': true }), true);
        assert.strictEqual(await packer._validateCondition('a', { 'a': false }), false);
        assert.strictEqual(await packer._validateCondition({ 'or': ['a', 'b'] }, { 'a': false, 'b': true }), true);
        assert.strictEqual(await packer._validateCondition({ 'and': ['a', 'b'] }, { 'a': false, 'b': true }), false);
        assert.strictEqual(await packer._validateCondition({ 'or': ['a', 'b'] }, { 'a': true, 'b': true }), true);
        assert.strictEqual(await packer._validateCondition({ 'and': ['a', 'b'] }, { 'a': true, 'b': true }), true);
        assert.strictEqual(await packer._validateCondition({ 'or': ['a', 'b'] }, { 'a': true, 'b': false }), true);
        assert.strictEqual(await packer._validateCondition({ 'and': ['a', 'b'] }, { 'a': true, 'b': false }), false);
        assert.strictEqual(await packer._validateCondition({ 'or': ['a', 'b'] }, { 'a': false, 'b': false }), false);
        assert.strictEqual(await packer._validateCondition({ 'and': ['a', 'b'] }, { 'a': false, 'b': false }), false);

    }).slow('1s');

});