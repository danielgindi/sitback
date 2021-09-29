import { spawn } from 'child_process';
import Fs from 'fs';

class DotnetUtil {

    /** @returns {string} */
    static async detectDotnetPath() {
        let options = [];

        for (let programFiles of [
            process.env['ProgramFiles'],
            process.env['ProgramFiles(x86)']].filter(x => x)) {
            options.push(`${programFiles}\\dotnet\\dotnet.exe`);
        }

        for (let path of options) {
            if (Fs.existsSync(path))
                return path;
        }

        return null;
    }

    /**
     * @param {object} options
     * @param {string} options.command
     * @param {string[]=} options.args
     * @param {boolean=} options.verbose
     * @param {string=} options.cwd
     * @param {Object<string, string>} options.props
     */
    static async runDotnet(options) {
        let msbuild = await this.detectDotnetPath();
        let args = [];

        args.push(options.command);

        if (Array.isArray(options.args)) {
            args.push(...options.args);
        }

        if (options.props) {
            for (let key of Object.keys(options.props)) {
                args.push(`/p:${key}=${options.props[key]}`);
            }
        }

        await new Promise((resolve, reject) => {
            let subp = spawn(msbuild, args, { cwd: options['cwd'] || undefined });

            let stderr = [], stdout = [];
            subp.stderr.on('data', data => stderr.push(data));
            subp.stdout.on('data', data => stdout.push(data));

            subp.on('error', err => {
                if (stderr.length)
                    err.message += '\n' + Buffer.concat(stderr).toString('utf8');

                reject(err);
            });
            subp.on('exit', () => {
                if (stderr.length) {
                    return reject(new Error(Buffer.concat(stderr).toString('utf8')));
                }

                resolve();
            });

            if (options['verbose']) {
                subp.stdout.on('data', data => process.stdout.write(data));
                subp.stderr.on('data', data => process.stderr.write(data));
            }
        });
    }

}

export default DotnetUtil;
