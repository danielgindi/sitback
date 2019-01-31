const execAsync = require('util').promisify(require('child_process').exec);

/**
 * Git diff status
 * @readonly
 * @name GitDiffStatus
 * @enum {number}
 */
const GitDiffStatus = {
    ADDED: 'A',
    DELETED: 'D',
    MODIFIED: 'M',
    TYPE_CHANGED: 'T',
    UNMERGED: 'U',
    UNKNOWN: 'X',
    BROKEN: 'B',
    RENAMED: 'R',
    COPIED: 'C',
};

/**
 * @typedef {object} GitDiffItem
 * @property {GitDiffStatus} status
 * @property {number=} accuracy
 * @property {string} path
 * @property {string=} toPath
 */

/** */
class GitUtil {

    /** @returns {GitDiffItem[]} */
    static async fetchGitDiffList(/**string=*/from = 'master', /**string=*/to = 'HEAD', /**string=*/folder) {
        const { stdout, stderr } = await execAsync(`git diff --relative --name-status ${from}...${to}`, {
            cwd: folder || undefined,
        });

        if (stderr)
            throw new Error(stderr);

        let list = stdout.split('\n').filter(x => !!x);
        let files = list.map(line => {
            let [ status, path, toPath ] = line.split('\t');
            let statusCode = status.trim()[0];
            path = path.trim();
            toPath = toPath ? toPath.trim() : null;

            if (statusCode === GitDiffStatus.RENAMED ||
                statusCode === GitDiffStatus.COPIED) {

                let accuracy = 1;

                if (status.length > 1) {
                    accuracy = parseInt(status.substr(1), 10) / 100;
                }

                return {
                    status: statusCode,
                    accuracy: accuracy,
                    path: path,
                    toPath: toPath,
                };
            } else {
                return {
                    status: statusCode,
                    path: path,
                };
            }
        });

        return files;
    }

}

GitUtil.GitDiffStatus = GitDiffStatus;

module.exports = GitUtil;