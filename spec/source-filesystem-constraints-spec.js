/*global describe, it, expect, beforeEach, afterEach */
const fs = require('fs');
const path = require('path');
const os = require('os');
const SourceFilesystemConstraints = require('../src/commands/source-filesystem-constraints');

describe('@integration sourceFilesystemContraints', () => {
  describe('The temp directory cannot be the os temp directory', () => {
    it('returns true if the source is the os tmpdir', () => {
      const constraints = new SourceFilesystemConstraints(os.tmpdir());
      const result = constraints.isForbiddenLocation();
      expect(result).toEqual(true);
    });

    it('returns false if the source is NOT the os tmpdir', () => {
      const constraints = new SourceFilesystemConstraints('some/other/tmpdir');
      const result = constraints.isForbiddenLocation();
      expect(result).toEqual(false);
    });
  });
  describe('The temp directory must contain a package.json file', () => {
    it('returns true if a package.json file exits', () => {
      const pathName = os.tmpdir();
      const constraints = new SourceFilesystemConstraints(pathName);
      fs.writeFileSync(path.join(pathName, 'package.json'), '123', 'utf8');
      const result = constraints.listsDependencies();
      expect(result).toEqual(true);
    });

    it('returns false if a package.json file does NOT exist', () => {
      const constraints = new SourceFilesystemConstraints('some/other/tmpdir');
      const result = constraints.listsDependencies();
      expect(result).toEqual(false);
    });
  });  
});
