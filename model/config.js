import fs from 'node:fs';
import _ from 'lodash';
import YAML from 'yaml';
import chokidar from 'chokidar';
import Base from "./base.js";

class RConfig extends Base{
    constructor(e) {
        super(e);
        this.configPath = `./plugins/${RConfig.pluginName}/config/`;
        this.previousContent = new Map();
        this.watchers = new Map();
    }

    getConfig(name) {
        return this.getYaml(name);
    }

    getField(name, field) {
        const config = this.getConfig(name);
        return config[field];
    }

    updateField(name, field, value) {
        let config = this.getConfig(name);
        config[field] = value;
        logger.mark(`[shiloh-plugin][修改配置项][${name}][${field}]修改为：${value}`);
        this.saveAllConfig(name, config);
    }

    deleteField(name, field) {
        let config = this.getConfig(name);
        delete config[field];
        this.saveAllConfig(name, config);
    }

    getYaml(name, isWatch = true) {
        let file = this.getFilePath(name);
        const yaml = YAML.parse(fs.readFileSync(file, 'utf8'));

        this.previousContent.set(name, yaml);
        if (isWatch) {
            this.watch(file, name);
        }
        return yaml;
    }

    getFilePath(name) {
        return `${this.configPath}${name}.yaml`;
    }

    watch(file, name) {
        if (this.watchers.has(name)) return;

        const watcher = chokidar.watch(file, {
            ignoreInitial: true
        });

        watcher.on('change', path => {
            try {
                const currentContent = YAML.parse(fs.readFileSync(path, 'utf8'));
                const previousContent = this.previousContent.get(name);

                if (!_.isEqual(previousContent, currentContent)) {
                    logger.mark(`[shiloh-plugin][配置文件]：${name}已被重新加载`);
                    this.previousContent.set(name, currentContent);
                }
            } catch (error) {
                logger.error(`[shiloh-plugin][配置文件]：${name}读取失败`, error);
            }
        });

        watcher.on('unlink', () => {
            this.previousContent.delete(name);
        });

        watcher.on('error', error => {
            logger.error(`[shiloh-plugin][配置文件]：${name}监听失败`, error);
        });

        this.watchers.set(name, watcher);
    }

    saveAllConfig(name, data) {
        let file = this.getFilePath(name);
        if (_.isEmpty(data)) {
            fs.existsSync(file) && fs.unlinkSync(file);
            this.previousContent.delete(name);
        } else {
            let yaml = YAML.stringify(data);
            fs.writeFileSync(file, yaml, 'utf8');
            this.previousContent.set(name, data);
        }
        this.watch(file, name);
    }

    async closeWatchers() {
        for (const watcher of this.watchers.values()) {
            await watcher.close().catch(() => {});
        }
        this.watchers.clear();
    }
}

export default new RConfig();
