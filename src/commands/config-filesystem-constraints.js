const path = require('path');
const fsUtil = require('../util/fs-util');

class ConfigFilesystemConstraints {
  constructor(configFile) {
    this.configFile = configFile;
  }

  configExists() {
    return fsUtil.fileExists(this.configFile);
  }

  configIsWritable() {
    return fsUtil.isDir(path.dirname(this.configFile));
  }
}

module.exports = ConfigFilesystemConstraints;
