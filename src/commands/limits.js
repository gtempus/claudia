const limits = require('../util/limits.json');

class Limits {
  constructor(theLimits = limits) {
    this.limits = theLimits;
  }

  lambdaMemoryMin() {
    return this.limits.LAMBDA.MEMORY.MIN;
  }

  lambdaMemoryMax() {
    return this.limits.LAMBDA.MEMORY.MAX;
  }
}

module.exports = Limits;
