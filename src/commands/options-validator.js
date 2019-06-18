const SourceFilesystemConstraints = require('./source-filesystem-constraints');
const ConfigFilesystemConstraints = require('./config-filesystem-constraints');
const Limits = require('./limits');
const isRoleArn = require('../util/is-role-arn'); // no side-effects. Will not need to break this dependency.

class OptionsValidator {
  constructor(source, options, configFile, policyFiles,
              sourceConstraints = new SourceFilesystemConstraints(source),
              configFileConstraints = new ConfigFilesystemConstraints(configFile),
              limitConstraints = new Limits()) {
    this.sourceConstraints = sourceConstraints;
    this.configFileConstraints = configFileConstraints;
    this.options = options;
    this.policyFiles = policyFiles;
    this.errorMessage = null;
  }

  badSourceDirectory() {
    return this.sourceConstraints.isForbiddenLocation();
  }

  sourceDirectoryListsDependencies() {
    return this.sourceConstraints.listsDependencies();
  }

  configFileExists() {
    return this.configFileConstraints.configExists();
  }

  configFileIsWritable() {
    return this.configFileConstraints.configIsWritable();
  }

  minLambdaMemory() {
    return this.limitConstraints.lambdaMemoryMin();
  }

  maxLambdaMemory() {
    return this.limitConstraints.lambdaMemoryMax();
  }

  validationError() {
    if (this.badSourceDirectory()) {
      return 'Source directory is the Node temp directory. Cowardly refusing to fill up disk with recursive copy.';
    }
    if (!this.options.region) {
      return 'AWS region is missing. please specify with --region';
    }
    if (this.options['optional-dependencies'] === false && this.options['use-local-dependencies']) {
      return 'incompatible arguments --use-local-dependencies and --no-optional-dependencies';
    }
    if (!this.options.handler && !this.options['api-module']) {
      return 'Lambda handler is missing. please specify with --handler';
    }
    if (this.options.handler && this.options['api-module']) {
      return 'incompatible arguments: cannot specify handler and api-module at the same time.';
    }
    if (!this.options.handler && this.options['deploy-proxy-api']) {
      return 'deploy-proxy-api requires a handler. please specify with --handler';
    }
    if (!this.options['security-group-ids'] && this.options['subnet-ids']) {
      return 'VPC access requires at least one security group id *and* one subnet id';
    }
    if (this.options['security-group-ids'] && !this.options['subnet-ids']) {
      return 'VPC access requires at least one security group id *and* one subnet id';
    }
    if (this.options.handler && this.options.handler.indexOf('.') < 0) {
      return 'Lambda handler function not specified. Please specify with --handler module.function';
    }
    if (this.options['api-module'] && this.options['api-module'].indexOf('.') >= 0) {
      return 'API module must be a module name, without the file extension or function name';
    }
    if (!this.configFileIsWritable()) {
      return 'cannot write to ' + this.configFileConstraints.theConfigFile();
    }
    if (this.configFileExists()) {
      if (this.options && this.options.config) {
        return this.options.config + ' already exists';
      }
      return 'claudia.json already exists in the source folder';
    }
    if (!this.sourceDirectoryListsDependencies()) {
      return 'package.json does not exist in the source folder';
    }
    if (this.options.policies && !this.policyFiles().length) {
      return 'no files match additional policies (' + this.options.policies + ')';
    }
    if (this.options.memory || this.options.memory === 0) {
      if (this.options.memory < this.minLambdaMemory()) {
        return `the memory value provided must be greater than or equal to ${this.minLambdaMemory()}`;
      }
      if (this.options.memory > this.maxLambdaMemory()) {
        return `the memory value provided must be less than or equal to ${this.maxLambdaMemory()}`;
      }
      if (this.options.memory % 64 !== 0) {
        return 'the memory value provided must be a multiple of 64';
      }
    }
    if (this.options.timeout || this.options.timeout === 0) {
      if (this.options.timeout < 1) {
        return 'the timeout value provided must be greater than or equal to 1';
      }
      if (this.options.timeout > 900) {
        return 'the timeout value provided must be less than or equal to 900';
      }
    }
    if (this.options['allow-recursion'] && this.options.role && isRoleArn(this.options.role)) {
      return 'incompatible arguments allow-recursion and role. When specifying a role ARN, Claudia does not patch IAM policies.';
    }
  };

  checkForValidationErrors() {
    this.errorMessage = this.validationError();
  };

  validationErrorsExist() {
    return !!this.errorMessage;
  };
}

module.exports = OptionsValidator;
