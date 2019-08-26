const Path = require('path');
const Tmp = require('tmp');
const AdmZip = require('adm-zip');
const FsExtra = require('fs-extra');
const TreeSync = require('tree-sync');
const XmlUtil = require('../utils/xml');
const { spawn } = require('child_process');

/**
 * @typedef {Object} UnpackRule_Copy
 * @property {'copy'} type
 * @property {string} path
 */

/**
 * @typedef {Object} UnpackRule_Delete
 * @property {'delete'} type
 * @property {string} path
 */

/**
 * @typedef {Object} UnpackRule_Sync
 * @property {'sync'} type
 * @property {string} path
 * @property {string[]=} exclude
 */

/**
 * @typedef {Object} UnpackRule_Xml
 * @property {'xml'} type
 * @property {string} path - file path
 * @property {{mode: 'replace'|'insert', path: string, xml: string}[]} actions
 */

/**
 * @typedef {Object} UnpackRule_Cmd
 * @property {'cmd'} type
 * @property {{path: string, args: string[]=, cwd: string=}[]} commands
 */

/**
 * @typedef {UnpackRule_Copy|UnpackRule_Delete|UnpackRule_Sync|UnpackRule_Xml} UnpackRule
 */

class Unpacker {
    constructor() {
        this.state = {
            /**@type UnpackRule[]=*/
            rules: [],

            /**@type string=*/
            zipFilePath: null,
        };
    }

    /** @returns {UnpackRule[]} */
    get rules() {
        return this.state.rules;
    }

    set rules(/**UnpackRule[]*/rules) {
        this.state.rules = rules;
    }

    /** @returns {string} */
    get zipFilePath() {
        return this.state.zipFilePath;
    }

    set zipFilePath(/**string*/zipFilePath) {
        this.state.zipFilePath = zipFilePath;
    }

    async run(/**string*/outputFolder) {
        let tmpDir = Tmp.dirSync({}).name;

        const zip = new AdmZip(this.zipFilePath);
        if (zip.getEntries().length > 0) {
            await require('util').promisify(zip.extractAllToAsync).call(zip, tmpDir, true);
        }
        
        for (let rule of this.rules) {
            switch (rule.type) {
                case 'copy':
                    await FsExtra.copy(
                        Path.join(tmpDir, rule.path),
                        Path.join(outputFolder, rule.path)
                    );
                    break;

                case 'delete':
                    await FsExtra.remove(Path.join(outputFolder, rule.path));
                    break;

                case 'sync': {
                    const tree = new TreeSync(
                        Path.join(tmpDir, rule.path),
                        Path.join(outputFolder, rule.path),
                        {
                            ignore: rule.exclude || [],
                        }
                    );
                    tree.sync();
                    break;
                }

                case 'xml': {
                    const xmlFilePath = Path.join(outputFolder, rule.path);

                    let xmlTree = XmlUtil.parseXmlAtFile(xmlFilePath);
                    
                    for (let action of rule.actions) {
                        if (action.mode === 'replace') {
                            if (action.xml === null) {
                                XmlUtil.deleteNodeAt(xmlTree, action.path);
                            } else {
                                XmlUtil.replaceNodeInto(
                                    XmlUtil.parseXml(action.xml), 
                                    xmlTree,
                                    action.path);
                            }
                        }
                        else if (action.mode === 'insert') {
                            XmlUtil.replaceNodeInto(
                                XmlUtil.parseXml(action.xml),
                                xmlTree,
                                action.path);
                        }
                    }

                    await FsExtra.writeFile(xmlFilePath, XmlUtil.stringify(xmlTree), { encoding: 'utf8' });

                    break;
                }

                case 'cmd': {
                    for (let command of rule.commands) {
                        await new Promise((resolve, reject) => {
                            let subp = spawn(
                                command.path,
                                [].concat(command.args || []),
                                {
                                    cwd: command.cwd || undefined,
                                    shell: true,
                                }
                            );

                            let stderr = [];
                            subp.stderr.on('data', data => stderr.push(data));            

                            subp.on('error', err => {
                                if (stderr.length)
                                    err.message += '\n' + Buffer.concat(stderr).toString('utf8');

                                reject(err);
                            });

                            subp.on('exit', () => {
                                resolve();
                            });

                            subp.stdout.on('data', data => process.stdout.write(data));
                            subp.stderr.on('data', data => process.stderr.write(data));
                        });
                    }
                    break;
                }

                default:
                    throw new Error('Unsupported action');
            }
        }

        await FsExtra.remove(tmpDir);
    }
}

module.exports = Unpacker;