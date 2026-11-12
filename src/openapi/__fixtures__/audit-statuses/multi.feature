Feature: Several operations

  Scenario: two operations, one status
    When I send the request a to the createWidget operation
    And I send the request empty to the getWidget operation
    Then the response status should be 200
    And the response status should be 500

  Scenario: reference with no status
    When I send the request empty to the deleteWidget operation
    And the response body at id should equal "1"

  Scenario: status before any reference
    Then the response status should be 204
    When I send the request empty to the deleteWidget operation
