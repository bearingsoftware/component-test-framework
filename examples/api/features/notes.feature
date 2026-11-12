Feature: Notes API
  The service saves a note once the moderation service approves it.

  Scenario: A note the moderation service approves is saved
    Given the moderation API is stubbed from wiremock/moderation-ok
    When I send the request notes/create to the createNote operation
    Then the response status should be 201
    And the response body at title should equal "Buy milk"
    And the api_notes table contains 1 row matching "title = 'Buy milk'"
    And the moderation API at "/moderation/check" was called 1 time

  Scenario: A note the moderation service rejects is not saved
    Given the moderation API returns HTTP 422
    When I send the request notes/create to the createNote operation
    Then the response status should be 422
    And the api_notes table is empty
