Feature: The core entry point
  Steps come only from the groups a suite registers, through the built package.

  Scenario: A registered step group works, registered twice without ambiguity
    Given a response with status 204
    Then the response status should be 204

  Scenario: Lifecycle hooks run in order
    Then the afterReset hook has run for this scenario
