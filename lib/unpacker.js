import Path from 'path';
import Tmp from 'tmp';
import AdmZip from 'adm-zip';
import FsExtra from 'fs-extra';
import TreeSync from 'tree-sync';
import XmlUtil from '../utils/xml.js';
import { spawn } from 'child_process';
import { promisify } from 'util';

/**
 * @typedef {Object} UnpackRule_Copy
 * @property {'copy'} type
 * @property {string} path
 * @property {boolean?} ignoreErrors
 * @property {number?} retry
 */

/**
 * @typedef {Object} UnpackRule_Delete
 * @property {'delete'} type
 * @property {string} path
 * @property {boolean?} skipNotFound
 * @property {boolean?} ignoreErrors
 * @property {number?} retry
 */

/**
 * @typedef {Object} UnpackRule_Sync
 * @property {'sync'} type
 * @property {string} path
 * @property {string[]=} exclude
 * @property {boolean?} ignoreErrors
 * @property {number?} retry
 */

/**
 * @typedef {Object} UnpackRule_Xml
 * @property {'xml'} type
 * @property {string} path - file path
 * @property {UnpackRule_Xml_Action[]} actions
 * @property {boolean?} ignoreErrors
 * @property {number?} retry
 */
 
/**
 * @typedef {Object} UnpackRule_Xml_Action
 * @property {'replace'|'insert'} mode
 * @property {string} path
 * @property {xml} string
 * @property {boolean?} ignoreErrors
 * @property {number?} retry
 */
 
/**
 * @typedef {Object} UnpackRule_Cmd_Command
 * @property {string} path
 * @property {string[]?} args
 * @property {string?} cwd
 * @property {boolean?} ignoreErrors
 * @property {number?} retry
 */

/**
 * @typedef {Object} UnpackRule_Cmd
 * @property {'cmd'} type
 * @property {UnpackRule_Cmd_Command[]} commands
 * @property {boolean?} ignoreErrors
 * @property {number?} retry
 */

/**
 * @typedef {UnpackRule_Copy|UnpackRule_Delete|UnpackRule_Sync|UnpackRule_Xml} UnpackRule
 */
 
async function autoRetry(execute, retry, ignoreErrors, onIgnore) {
    let lastErr = null;
    for (let i = 0; i < Math.max(1, retry || 0); i++) {
        try {
            lastErr = null;
            await execute();
            break;
        } catch (err) {
            lastErr = err;
        }
    }

    if (lastErr) {
        if (ignoreErrors) {
            onIgnore(lastErr);
        } else {
            throw lastErr;
        }
    }
}
 
/** */
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
            await promisify(zip.extractAllToAsync).call(zip, tmpDir, true);
        }

        for (let rule of this.rules) {
            switch (rule.type) {
                case 'copy':
                    await autoRetry(async () => {
                        await FsExtra.copy(
                            Path.join(tmpDir, rule.path),
                            Path.join(outputFolder, rule.path),
                        );
                    }, rule.retry, rule.ignoreErrors, err => {
                        // eslint-disable-next-line no-console
                        console.warn('Can\'t copy file: ' + rule.path + ' (' + err.message + ')');
                    });
                    break;

                case 'delete':
                    await autoRetry(async () => {
                        try {
                            await FsExtra.remove(Path.join(outputFolder, rule.path));
                        } catch (err) {
                            if (!rule.skipNotFound)
                                throw err;

                            // eslint-disable-next-line no-console
                            console.warn('Can\'t delete missing file: ' + rule.path + ' (' + err.message + ')');
                        }
                    }, rule.retry, rule.ignoreErrors, err => {
                        // eslint-disable-next-line no-console
                        console.warn('Can\'t delete file at: ' + rule.path + ' (' + err.message + ')');
                    });
                    break;

                case 'sync': {
                    await autoRetry(() => {
                        const tree = new TreeSync(
                            Path.join(tmpDir, rule.path),
                            Path.join(outputFolder, rule.path),
                            {
                                ignore: rule.exclude || [],
                            },
                        );
                        tree.sync();
                    }, rule.retry, rule.ignoreErrors, err => {
                        // eslint-disable-next-line no-console
                        console.warn('Can\'t sync files at: ' + rule.path + ' (' + err.message + ')');
                    });
                    break;
                }

                case 'xml': {
                    const xmlFilePath = Path.join(outputFolder, rule.path);

                    let xmlTree = XmlUtil.parseXmlAtFile(xmlFilePath);

                    for (let action of rule.actions) {
                        const execute = () => {
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
                        };
                        
                        await autoRetry(execute, action.retry ?? rule.retry, action.ignoreErrors ?? rule.ignoreErrors, err => {
                            // eslint-disable-next-line no-console
                            console.warn('Can\'t update xml: ' + action.path + ' (' + err.message + ')');
                        });
                    }

                    await FsExtra.writeFile(xmlFilePath, XmlUtil.stringify(xmlTree), { encoding: 'utf8' });

                    break;
                }

                case 'cmd': {
                    for (let command of rule.commands) {
                        let execute = async () => {
                            return new Promise((resolve, reject) => {
                                let subp = spawn(
                                    command.path.replace(/%([^%]+)%/g, (_, v) => process.env[v]),
                                    [].concat(command.args || []),
                                    {
                                        cwd: command.cwd || undefined,
                                        shell: true,
                                    },
                                );

                                let stderr = [];
                                subp.stderr.on('data', data => stderr.push(data));

                                subp.on('error', err => {
                                    if (stderr.length)
                                        err.message += '\n' + Buffer.concat(stderr).toString('utf8');

                                    reject(err);
                                });

                                subp.on('exit', () => {
									if (stderr.length)
										reject(new Error(Buffer.concat(stderr).toString('utf8')));
									else resolve();
                                });

                                subp.stdout.on('data', data => process.stdout.write(data));
                                subp.stderr.on('data', data => process.stderr.write(data));
                            });
                        };

                        await autoRetry(execute, command.retry ?? rule.retry, command.ignoreErrors ?? rule.ignoreErrors, err => {
                            // eslint-disable-next-line no-console
                            console.warn('Can\'t execute command: ' + command.path + ' (' + err.message + ')');
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

export default Unpacker;
