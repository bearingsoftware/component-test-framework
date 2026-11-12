Feature: Job worker
  The worker takes jobs from the "jobs" channel, records them and reports the result.

  Scenario: A job is processed
    When I publish "{\"id\":\"42\"}" to Valkey channel "jobs"
    Then the worker_jobs table contains 1 row matching "job_id = '42' AND status = 'done'"
    And the Valkey key "job:42" eventually contains JSON matching "{\"status\":\"done\"}"

  Scenario: A job that fails is recorded as failed
    When I publish "{\"id\":\"43\",\"fail\":true}" to Valkey channel "jobs"
    Then the worker_jobs table contains 1 row matching "job_id = '43' AND status = 'failed'"
    And the Valkey key "job:43" eventually contains JSON matching "{\"status\":\"failed\"}"
