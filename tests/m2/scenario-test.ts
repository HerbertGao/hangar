import test, { type TestContext } from "node:test";

type ScenarioTest = typeof test & {
  scenarios(
    scenarioIds: readonly string[],
    name: string,
    body: (context: TestContext) => void | Promise<void>,
  ): void;
};

// Scenario IDs are owned by OpenSpec/oracle mapping; Node receives the same
// executable body without introducing a second runner.
const scenarioTest = test as ScenarioTest;
scenarioTest.scenarios = (_scenarioIds, name, body) => test(name, body);

export default scenarioTest;
