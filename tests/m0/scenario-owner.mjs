import nativeTest from "node:test";

function scenarioTest(...args) {
  return nativeTest(...args);
}

scenarioTest.scenarios = (_scenarioIds, ...args) => nativeTest(...args);

export default scenarioTest;
