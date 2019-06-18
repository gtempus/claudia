const path = require('path'),
      os = require('os'),
      fs = require('fs'),
      aws = require('aws-sdk'),
      retry = require('oh-no-i-insist'),
      apiGWUrl = require('../util/apigw-url'),
      fsPromise = require('../util/fs-promise'),
      fsUtil = require('../util/fs-util'),
      initEnvVarsFromOptions = require('../util/init-env-vars-from-options'),
      isRoleArn = require('../util/is-role-arn'),
      lambdaNameSanitize = require('../util/lambda-name-sanitize'),
      loggingWrap = require('../util/logging-wrap'),
      NullLogger = require('../util/null-logger'),
      readjson = require('../util/readjson'),
      retriableWrap = require('../util/retriable-wrap'),
      templateFile = require('../util/template-file'),
      addPolicy = require('../tasks/add-policy'),
      cleanUpPackage = require('../tasks/clean-up-package'),
      collectFiles = require('../tasks/collect-files'),
      deployProxyApi = require('../tasks/deploy-proxy-api'),
      lambdaCode = require('../tasks/lambda-code'),
      markAlias = require('../tasks/mark-alias'),
      rebuildWebApi = require('../tasks/rebuild-web-api'),
      validatePackage = require('../tasks/validate-package'),
      zipdir = require('../tasks/zipdir'),
      OptionsValidator = require('./options-validator');

module.exports = function create(options, optionalLogger) {
  'use strict';
  let roleMetadata,
      s3Key,
      packageArchive,
      functionDesc,
      customEnvVars,
      functionName,
      workingDir,
      packageFileDir;
  const logger = optionalLogger || new NullLogger(),
	awsDelay = options && options['aws-delay'] && parseInt(options['aws-delay'], 10) || (process.env.AWS_DELAY && parseInt(process.env.AWS_DELAY, 10)) || 5000,
	awsRetries = options && options['aws-retries'] && parseInt(options['aws-retries'], 10) || 15,
	source = (options && options.source) || process.cwd(),
	configFile = (options && options.config) || path.join(source, 'claudia.json'),
	iam = loggingWrap(new aws.IAM({region: options.region}), {log: logger.logApiCall, logName: 'iam'}),
	lambda = loggingWrap(new aws.Lambda({region: options.region}), {log: logger.logApiCall, logName: 'lambda'}),
	s3 = loggingWrap(new aws.S3({region: options.region, signatureVersion: 'v4'}), {log: logger.logApiCall, logName: 's3'}),
	apiGatewayPromise = retriableWrap(
	  loggingWrap(new aws.APIGateway({region: options.region}), {log: logger.logApiCall, logName: 'apigateway'}),
	  () => logger.logStage('rate-limited by AWS, waiting before retry')
	),
	policyFiles = function () {
          if (!options.policies) return [];
          let files = fsUtil.recursiveList(options.policies);
          if (fsUtil.isDir(options.policies)) {
            files = files.map(filePath => path.join(options.policies, filePath));
          }
          return files.filter(fsUtil.isFile);
        },
	getPackageInfo = function () {
	  logger.logStage('loading package config');
	  return readjson(path.join(source, 'package.json'))
	    .then(jsonConfig => {
	      const name = options.name || lambdaNameSanitize(jsonConfig.name),
		    description = options.description || (jsonConfig.description && jsonConfig.description.trim());
	      if (!name) {
		return Promise.reject('project name is missing. please specify with --name or in package.json');
	      }
	      return {
		name: name,
		description: description
	      };
	    });
	},
	createLambda = function (functionName, functionDesc, functionCode, roleArn) {
	  return retry(
	    () => {
	      logger.logStage('creating Lambda');
	      return lambda.createFunction({
		Code: functionCode,
		FunctionName: functionName,
		Description: functionDesc,
		MemorySize: options.memory,
		Timeout: options.timeout,
		Environment: customEnvVars,
		KMSKeyArn: options['env-kms-key-arn'],
		Handler: options.handler || (options['api-module'] + '.proxyRouter'),
		Role: roleArn,
		Runtime: options.runtime || 'nodejs10.x',
		Publish: true,
		Layers: options.layers && options.layers.split(','),
		VpcConfig: options['security-group-ids'] && options['subnet-ids'] && {
		  SecurityGroupIds: (options['security-group-ids'] && options['security-group-ids'].split(',')),
		  SubnetIds: (options['subnet-ids'] && options['subnet-ids'].split(','))
		}
	      }).promise();
	    },
	    awsDelay, awsRetries,
	    error => {
	      return error &&
		error.code === 'InvalidParameterValueException' &&
		(error.message === 'The role defined for the function cannot be assumed by Lambda.'
		 || error.message === 'The provided execution role does not have permissions to call CreateNetworkInterface on EC2'
		 || error.message.startsWith('Lambda was unable to configure access to your environment variables because the KMS key is invalid for CreateGrant.')
		);
	    },
	    () => logger.logStage('waiting for IAM role propagation'),
	    Promise
	  );
	},
	markAliases = function (lambdaData) {
	  logger.logStage('creating version alias');
	  return markAlias(lambdaData.FunctionName, lambda, '$LATEST', 'latest')
	    .then(() => {
	      if (options.version) {
		return markAlias(lambdaData.FunctionName, lambda, lambdaData.Version, options.version);
	      }
	    })
	    .then(() =>lambdaData);
	},
	createWebApi = function (lambdaMetadata, packageDir) {
	  let apiModule, apiConfig, apiModulePath;
	  const alias = options.version || 'latest';
	  logger.logStage('creating REST API');
	  try {
	    apiModulePath = path.join(packageDir, options['api-module']);
	    apiModule = require(path.resolve(apiModulePath));
	    apiConfig = apiModule && apiModule.apiConfig && apiModule.apiConfig();
	  } catch (e) {
	    console.error(e.stack || e);
	    return Promise.reject(`cannot load api config from ${apiModulePath}`);
	  }

	  if (!apiConfig) {
	    return Promise.reject(`No apiConfig defined on module '${options['api-module']}'. Are you missing a module.exports?`);
	  }
	  return apiGatewayPromise.createRestApiPromise({
	    name: lambdaMetadata.FunctionName
	  })
	    .then((result) => {
	      lambdaMetadata.api = {
		id: result.id,
		module: options['api-module'],
		url: apiGWUrl(result.id, options.region, alias)
	      };
	      return rebuildWebApi(lambdaMetadata.FunctionName, alias, result.id, apiConfig, options.region, logger, options['cache-api-config']);
	    })
	    .then(() => {
	      if (apiModule.postDeploy) {
		return apiModule.postDeploy(
		  options,
		  {
		    name: lambdaMetadata.FunctionName,
		    alias: alias,
		    apiId: lambdaMetadata.api.id,
		    apiUrl: lambdaMetadata.api.url,
		    region: options.region
		  },
		  {
		    apiGatewayPromise: apiGatewayPromise,
		    aws: aws
		  }
		);
	      }
	    })
	    .then(postDeployResult => {
	      if (postDeployResult) {
		lambdaMetadata.api.deploy = postDeployResult;
	      }
	      return lambdaMetadata;
	    });
	},
	saveConfig = function (lambdaMetaData) {
	  const config = {
	    lambda: {
	      role: roleMetadata.Role.RoleName,
	      name: lambdaMetaData.FunctionName,
	      region: options.region
	    }
	  };
	  if (options.role) {
	    config.lambda.sharedRole = true;
	  }
	  logger.logStage('saving configuration');
	  if (lambdaMetaData.api) {
	    config.api =  { id: lambdaMetaData.api.id, module: lambdaMetaData.api.module };
	  }
	  return fsPromise.writeFileAsync(
	    configFile,
	    JSON.stringify(config, null, 2),
	    'utf8'
	  )
	    .then(() => lambdaMetaData);
	},
	formatResult = function (lambdaMetaData) {
	  const config = {
	    lambda: {
	      role: roleMetadata.Role.RoleName,
	      name: lambdaMetaData.FunctionName,
	      region: options.region
	    }
	  };
	  if (options.role) {
	    config.lambda.sharedRole = true;
	  }
	  if (lambdaMetaData.api) {
	    config.api =  lambdaMetaData.api;
	  }
	  if (s3Key) {
	    config.s3key = s3Key;
	  }
	  return config;
	},
	loadRole = function (functionName) {
	  logger.logStage('initialising IAM role');
	  if (options.role) {
	    if (isRoleArn(options.role)) {
	      return Promise.resolve({
		Role: {
		  RoleName: options.role,
		  Arn: options.role
		}
	      });
	    }
	    return iam.getRole({RoleName: options.role}).promise();
	  } else {
	    return fsPromise.readFileAsync(templateFile('lambda-exector-policy.json'), 'utf8')
	      .then(lambdaRolePolicy => {
		return iam.createRole({
		  RoleName: functionName + '-executor',
		  AssumeRolePolicyDocument: lambdaRolePolicy
		}).promise();
	      });
	  }
	},
	addExtraPolicies = function () {
	  return Promise.all(policyFiles().map(fileName => {
	    const policyName = path.basename(fileName).replace(/[^A-z0-9]/g, '-');
	    return addPolicy(iam, policyName, roleMetadata.Role.RoleName, fileName);
	  }));
	},
	recursivePolicy = function (functionName) {
	  return JSON.stringify({
	    'Version': '2012-10-17',
	    'Statement': [{
	      'Sid': 'InvokePermission',
	      'Effect': 'Allow',
	      'Action': [
		'lambda:InvokeFunction'
	      ],
	      'Resource': 'arn:aws:lambda:' + options.region + ':*:function:' + functionName
	    }]
	  });
	},
	cleanup = function (result) {
	  if (!options.keep) {
	    fsUtil.rmDir(workingDir);
	    fs.unlinkSync(packageArchive);
	  } else {
	    result.archive = packageArchive;
	  }
	  return result;
	};

  const validator = new OptionsValidator(source, options, configFile, policyFiles());
  validator.checkForValidationErrors();
  if (validator.validationErrorsExist()) return Promise.reject(validator.errorMessage);

  return initEnvVarsFromOptions(options)
    .then(opts => customEnvVars = opts)
    .then(getPackageInfo)
    .then(packageInfo => {
      functionName = packageInfo.name;
      functionDesc = packageInfo.description;
    })
    .then(() => fsPromise.mkdtempAsync(os.tmpdir() + path.sep))
    .then(dir => workingDir = dir)
    .then(() => collectFiles(source, workingDir, options, logger))
    .then(dir => {
      logger.logStage('validating package');
      return validatePackage(dir, options.handler, options['api-module']);
    })
    .then(dir => {
      packageFileDir = dir;
      return cleanUpPackage(dir, options, logger);
    })
    .then(dir => {
      logger.logStage('zipping package');
      return zipdir(dir);
    })
    .then(zipFile => {
      packageArchive = zipFile;
    })
    .then(() => loadRole(functionName))
    .then((result) => {
      roleMetadata = result;
    })
    .then(() => {
      if (!options.role) {
	return addPolicy(iam, 'log-writer', roleMetadata.Role.RoleName);
      }
    })
    .then(() => {
      if (options.policies) {
	return addExtraPolicies();
      }
    })
    .then(() => {
      if (options['security-group-ids'] && !isRoleArn(options.role)) {
	return fsPromise.readFileAsync(templateFile('vpc-policy.json'), 'utf8')
	  .then(vpcPolicy => iam.putRolePolicy({
	    RoleName: roleMetadata.Role.RoleName,
	    PolicyName: 'vpc-access-execution',
	    PolicyDocument: vpcPolicy
	  }).promise());
      }
    })
    .then(() => {
      if (options['allow-recursion']) {
	return iam.putRolePolicy({
	  RoleName: roleMetadata.Role.RoleName,
	  PolicyName: 'recursive-execution',
	  PolicyDocument: recursivePolicy(functionName)
	}).promise();
      }
    })
    .then(() => lambdaCode(s3, packageArchive, options['use-s3-bucket'], options['s3-sse']))
    .then(functionCode => {
      s3Key = functionCode.S3Key;
      return createLambda(functionName, functionDesc, functionCode, roleMetadata.Role.Arn);
    })
    .then(markAliases)
    .then(lambdaMetadata => {
      if (options['api-module']) {
	return createWebApi(lambdaMetadata, packageFileDir);
      } else if (options['deploy-proxy-api']) {
	return deployProxyApi(lambdaMetadata, options, apiGatewayPromise, logger);
      } else {
	return lambdaMetadata;
      }
    })
    .then(saveConfig)
    .then(formatResult)
    .then(cleanup);
};

module.exports.doc = {
  description: 'Create the initial lambda function and related security role.',
  priority: 1,
  args: [
    {
      argument: 'region',
      description: 'AWS region where to create the lambda',
      example: 'us-east-1'
    },
    {
      argument: 'handler',
      optional: true,
      description: 'Main function for Lambda to execute, as module.function',
      example: 'if it is in the main.js file and exported as router, this would be main.router'
    },
    {
      argument: 'api-module',
      optional: true,
      description: 'The main module to use when creating Web APIs. \n' +
	'If you provide this parameter, do not set the handler option.\n' +
	'This should be a module created using the Claudia API Builder.',
      example: 'if the api is defined in web.js, this would be web'
    },
    {
      argument: 'deploy-proxy-api',
      optional: true,
      description: 'If specified, a proxy API will be created for the Lambda \n' +
	' function on API Gateway, and forward all requests to function. \n' +
	' This is an alternative way to create web APIs to --api-module.'
    },
    {
      argument: 'name',
      optional: true,
      description: 'lambda function name',
      example: 'awesome-microservice',
      'default': 'the project name from package.json'
    },
    {
      argument: 'version',
      optional: true,
      description: 'A version alias to automatically assign to the new function',
      example: 'development'
    },
    {
      argument: 'source',
      optional: true,
      description: 'Directory with project files',
      'default': 'current directory'
    },
    {
      argument: 'config',
      optional: true,
      description: 'Config file where the creation result will be saved',
      'default': 'claudia.json'
    },
    {
      argument: 'policies',
      optional: true,
      description: 'A directory or file pattern for additional IAM policies\n' +
	'which will automatically be included into the security role for the function',
      example: 'policies/*.json'
    },
    {
      argument: 'allow-recursion',
      optional: true,
      description: 'Set up IAM permissions so a function can call itself recursively'
    },
    {
      argument: 'role',
      optional: true,
      description: 'The name or ARN of an existing role to assign to the function. \n' +
	'If not supplied, Claudia will create a new role. Supply an ARN to create a function without any IAM access.',
      example: 'arn:aws:iam::123456789012:role/FileConverter'
    },
    {
      argument: 'runtime',
      optional: true,
      description: 'Node.js runtime to use. For supported values, see\n http://docs.aws.amazon.com/lambda/latest/dg/API_CreateFunction.html',
      default: 'nodejs10.x'
    },
    {
      argument: 'description',
      optional: true,
      description: 'Textual description of the lambda function',
      default: 'the project description from package.json'
    },
    {
      argument: 'memory',
      optional: true,
      description: 'The amount of memory, in MB, your Lambda function is given.\nThe value must be a multiple of 64 MB.',
      default: 128
    },
    {
      argument: 'timeout',
      optional: true,
      description: 'The function execution time, in seconds, at which AWS Lambda should terminate the function',
      default: 3
    },
    {
      argument: 'no-optional-dependencies',
      optional: true,
      description: 'Do not upload optional dependencies to Lambda.'
    },
    {
      argument: 'use-local-dependencies',
      optional: true,
      description: 'Do not install dependencies, use local node_modules directory instead'
    },
    {
      argument: 'npm-options',
      optional: true,
      description: 'Any additional options to pass on to NPM when installing packages. Check https://docs.npmjs.com/cli/install for more information',
      example: '--ignore-scripts',
      since: '5.0.0'
    },
    {
      argument: 'cache-api-config',
      optional: true,
      example: 'claudiaConfigCache',
      description: 'Name of the stage variable for storing the current API configuration signature.\n' +
	'If set, it will also be used to check if the previously deployed configuration can be re-used and speed up deployment'
    },
    {
      argument: 'post-package-script',
      optional: true,
      example: 'customNpmScript',
      description: 'the name of a NPM script to execute custom processing after claudia finished packaging your files.\n' +
	'Note that development dependencies are not available at this point, but you can use npm uninstall to remove utility tools as part of this step.',
      since: '5.0.0'
    },
    {
      argument: 'keep',
      optional: true,
      description: 'keep the produced package archive on disk for troubleshooting purposes.\n' +
	'If not set, the temporary files will be removed after the Lambda function is successfully created'
    },
    {
      argument: 'use-s3-bucket',
      optional: true,
      example: 'claudia-uploads',
      description: 'The name of a S3 bucket that Claudia will use to upload the function code before installing in Lambda.\n' +
	'You can use this to upload large functions over slower connections more reliably, and to leave a binary artifact\n' +
	'after uploads for auditing purposes. If not set, the archive will be uploaded directly to Lambda'
    },
    {
      argument: 's3-sse',
      optional: true,
      example: 'AES256',
      description: 'The type of Server Side Encryption applied to the S3 bucket referenced in `--use-s3-bucket`'
    },
    {
      argument: 'aws-delay',
      optional: true,
      example: '3000',
      description: 'number of milliseconds betweeen retrying AWS operations if they fail',
      default: '5000'
    },
    {
      argument: 'aws-retries',
      optional: true,
      example: '15',
      description: 'number of times to retry AWS operations if they fail',
      default: '15'
    },
    {
      argument: 'security-group-ids',
      optional: true,
      example: 'sg-1234abcd',
      description: 'A comma-delimited list of AWS VPC Security Group IDs, which the function will be able to access.\n' +
	'Note: these security groups need to be part of the same VPC as the subnets provided with --subnet-ids.'
    },
    {
      argument: 'subnet-ids',
      optional: true,
      example: 'subnet-1234abcd,subnet-abcd4567',
      description: 'A comma-delimited list of AWS VPC Subnet IDs, which this function should be able to access.\n' +
	'At least one subnet is required if you are using VPC access.\n' +
	'Note: these subnets need to be part of the same VPC as the security groups provided with --security-group-ids.'
    },
    {
      argument: 'set-env',
      optional: true,
      example: 'S3BUCKET=testbucket,SNSQUEUE=testqueue',
      description: 'comma-separated list of VAR=VALUE environment variables to set'
    },
    {
      argument: 'set-env-from-json',
      optional: true,
      example: 'production-env.json',
      description: 'file path to a JSON file containing environment variables to set'
    },
    {
      argument: 'env-kms-key-arn',
      optional: true,
      description: 'KMS Key ARN to encrypt/decrypt environment variables'
    },
    {
      argument: 'layers',
      optional: true,
      description: 'A comma-delimited list of Lambda layers to attach to this function',
      example: 'arn:aws:lambda:us-east-1:12345678:layer:ffmpeg:4'
    }
  ]
};
