const fs = require('fs');
const path = require('path');
const os = require('os');
const fsUtil = require('../util/fs-util');

class SourceFilesystemConstraints {
  constructor(sourceDir) {
    this.sourceDir = sourceDir;
  }

  isForbiddenLocation() {
    return this.sourceDir === os.tmpdir();
  }

  listsDependencies() {
    return fsUtil.fileExists(path.join(this.sourceDir, 'package.json'));
  }
}

module.exports = SourceFilesystemConstraints;
