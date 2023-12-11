import test from 'ava';
import Path from 'path';
import { execSync } from 'child_process';
import FsExtra from 'fs-extra';
import AdmZip from 'adm-zip';
import recursiveReaddir from 'recursive-readdir';
import XmlUtil from '../utils/xml.js';
import Packer from '../lib/packer.js';
import Unpacker from '../lib/unpacker.js';
import { fileURLToPath } from 'url';

const __dirname = Path.dirname(fileURLToPath(import.meta.url));

const workdir = Path.join(__dirname, 'workdir_' + Math.random());
const gitPath = Path.join(workdir, 'gitsource');
const destPath = Path.join(workdir, 'dest');
const unpackPath = Path.join(workdir, 'unpack');

const getCurrentCommit = () => execSync('git rev-parse --verify HEAD', { cwd: gitPath }).toString().trim();
const checkout = commit => execSync(`git checkout ${commit}`, { cwd: gitPath, stdio: 'ignore' });

const COMMITS = {};

test.beforeEach(async () => {
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

test.afterEach(async () => {
    try {
        await FsExtra.remove(workdir);
    } catch { /* ignore */ }
});

test.serial('Git diff: Start to end', async t => {
    t.timeout(30000);

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

    t.is(archiveEntries.length, 6);
    t.is(config.length, archiveEntries.length);
    t.is(config.some(x => x.type !== 'copy'), false);
    t.deepEqual(config.map(x => x.path.replace(/\\/g, '/')), archiveEntries);
});

test.serial('Git diff: Halfway', async t => {
    t.timeout(30000);

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

    t.is(archiveEntries.length, 2);
    t.deepEqual(['bar/a.txt', 'foo/b.txt'], archiveEntries);
    t.deepEqual([
        { 'type': 'copy', 'path': Path.normalize('/bar/a.txt') },
        { 'type': 'copy', 'path': Path.normalize('/foo/b.txt') },
    ], config);
});

test.serial('Git diff: Exclusions', async t => {
    t.timeout(30000);

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

    t.is(config.some(x => /\.bin$/.test(x.path)), false);
});

test.serial('Git diff: Variables', async t => {
    t.timeout(30000);

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
    t.is(variables['has_bin_changes'], true);

    packer.gitBaseCommit = COMMITS.addedFooBbin;
    packer.gitTargetCommit = COMMITS.addedFooC;

    variables = await packer._determineVariables(packer.variableDefs);
    t.is(variables['has_bin_changes'], false);
});

test.serial('Git diff: Conditions', async t => {
    t.timeout(30000);

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

    t.truthy(config.length > 0);
});

test.serial('Sync: All', async t => {
    t.timeout(30000);

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

    t.is(archiveEntries.length, 7);
    t.is(config.length, 1);
    t.deepEqual(config, [{ "type": "sync", "path": "./" }]);
});

test.serial('Sync: Subfolder', async t => {
    t.timeout(30000);

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

    t.is(archiveEntries.length, 4);
    t.deepEqual(config, [{ "type": "sync", "path": "dest_foo" }]);
});

test.serial('Xml: All', async t => {
    t.timeout(30000);

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

    t.deepEqual(xmlTree, {
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
});

test.serial('Unpack: Complete', async t => {
    t.timeout(30000);

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
    t.deepEqual(sourceFiles, unpackedFiles);
    t.is(archiveEntries.length, unpackedFiles.length);
});

test.serial('Unpack: No stderr on retries', async t => {
    t.timeout(30000);

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

    let stderrDirty = false;

    let unpacker = new Unpacker();
    unpacker.rules = [
        {
            type: 'copy',
            path: 'foo',
            ignoreErrors: true,
            retry: 2,
        },
        {
            type: 'delete',
            path: 'foo',
            skipNotFound: true,
            ignoreErrors: true,
            retry: 2,
        },
        {
            type: 'delete',
            path: 'foo',
            skipNotFound: false,
            ignoreErrors: true,
            retry: 2,
        },
        {
            type: 'sync',
            path: 'foo',
            ignoreErrors: true,
            retry: 2,
        },
        {
            type: 'cmd',
            commands: [{
                'path': 'foo',
            }],
            ignoreErrors: true,
            retry: 2,
        },
    ];
    unpacker.zipFilePath = Path.join(destPath, 'test.zip');

    const stderrWrite = process.stderr.write;
    process.stderr.write = function (...args) {
        stderrDirty = true;
        stderrWrite.call(this, ...args);
    };
    try {
        await unpacker.run(unpackPath);
    } catch (ex) {
        console.log(ex);
        // ignore
    }
    process.stderr.write = stderrWrite;

    t.is(stderrDirty, false);
});

test.serial('Unpack: Has stderr when not ignored', async t => {
    t.timeout(30000);

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

    const rules = [
        {
            type: 'cmd',
            commands: [{
                'path': 'foo',
            }],
            ignoreErrors: false,
            retry: 1,
        },
    ];

    let stderrDirty = false;
    const stderrWrite = process.stderr.write;
    process.stderr.write = function (...args) {
        stderrDirty = true;
        stderrWrite.call(this, ...args);
    };

    for (const rule of rules) {
        stderrDirty = false;

        let unpacker = new Unpacker();
        unpacker.rules = [rule];
        unpacker.zipFilePath = Path.join(destPath, 'test.zip');

        try {
            await unpacker.run(unpackPath);
        } catch (_ignored) {
            stderrDirty = true;
        }

        if (!stderrDirty)
            break;
    }

    process.stderr.write = stderrWrite;

    t.is(stderrDirty, true);
});

test.serial('Unpack: Two stages sequence', async t => {
    t.timeout(30000);

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
    t.deepEqual(sourceFiles, unpackedFiles);
});
