import { spawn } from 'child_process';
import Fs from 'fs';

class MsbuildUtil {

    /** @returns {string} */
    static async detectMsbuildPath() {
        let options = [];

        for (let programFiles of [
            process.env['ProgramFiles'],
            process.env['ProgramFiles(x86)']].filter(x => x)) {
            for (let versionCode of ['Current', '17.0', '15.0', '14.0']) {
                for (let versionYear of ['2022', '2019', '2017']) {
                    options.push(`${programFiles}\\Microsoft Visual Studio\\${versionYear}\\Community\\MSBuild\\${versionCode}\\Bin\\MSBuild.exe`);
                }
            }
        }

        for (let path of options) {
            if (Fs.existsSync(path))
                return path;
        }

        return null;
    }

    /** @returns {string} */
    static async detectDevenvPath() {
        let options = [];

        for (let programFiles of [
            process.env['ProgramFiles'],
            process.env['ProgramFiles(x86)']].filter(x => x)) {
            for (let versionYear of ['2022', '2019', '2017']) {
                options.push(`${programFiles}\\Microsoft Visual Studio\\${versionYear}\\Community\\Common7\\IDE\\devenv.exe`);
            }
        }

        for (let path of options) {
            if (Fs.existsSync(path))
                return path;
        }

        return null;
    }

    /**
     * @param {object} options
     * @param {string} options.solution
     * @param {string=} options.target
     * @param {boolean=} options.verbose
     * @param {string=} options.cwd
     * @param {Object<string, string>} options.props
     */
    static async runMsbulid(options) {
        let msbuild = await this.detectMsbuildPath();
        let args = [];

        args.push(options.solution);

        if (options.target) {
            args.push(`/t:${[].concat(options.target).join(';')}`);
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

                let stdoutText = Buffer.concat(stdout).toString('utf8');

                if (/Build FAILED/.test(stdoutText)) {
                    return reject(new Error(stdoutText.match(/Build FAILED\.?((?:.|\n|\r)*)$/)[1].trim()));
                }

                if (/MSBUILD : error/.test(stdoutText)) {
                    return reject(new Error(stdoutText.match(/MSBUILD : (error (?:.|\n|\r)*)$/)[1].trim()));
                }

                resolve();
            });

            if (options['verbose']) {
                subp.stdout.on('data', data => process.stdout.write(data));
                subp.stderr.on('data', data => process.stderr.write(data));
            }
        });
    }

    /**
     * @param {object} options
     * @param {string} options.solution
     * @param {'Build'|'Clean'|'Deploy'|'Rebuild'} options.action
     * @param {string=} options.configuration
     * @param {string=} options.project
     * @param {string=} options.projectConfiguration
     * @param {boolean=} options.verbose
     * @param {string=} options.cwd
     * @param {Object<string, string>} options.props
     */
    static async runDevenv(options) {
        let devenv = await this.detectDevenvPath();
        let args = [];

        args.push(options.solution);
        args.push('/' + options.action);

        if (options.configuration) {
            args.push(options.configuration);
        }

        if (options.project) {
            args.push('/Project');
            args.push(`"${options.project}"`);
        }

        if (options.projectConfiguration) {
            args.push('/ProjectConfig');
            args.push(options.projectConfiguration);
        }

        await new Promise((resolve, reject) => {
            let subp = spawn(devenv, args, { cwd: options['cwd'] || undefined });

            let stderr = [];
            subp.stderr.on('data', data => stderr.push(data));

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

export default MsbuildUtil;
