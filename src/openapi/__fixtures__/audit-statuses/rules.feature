Feature: Rules

  Background:
    Given I send the request empty to the ping operation
    Then the response status should be 200

  Rule: reading
    Background:
      Given I send the request empty to the listWidgets operation
      Then the response status should be 200

    Scenario: fetch one
      When I send the request empty to the getWidget operation
      Then the response body should match:
        """
        Then the response status should be 200
        When I send the request x to the deleteWidget operation
        """
      And the response status should be 404

    Scenario: a table is not a step
      When I send the request empty to the getWidget operation
      Then the response body should contain:
        | field | value                               |
        | note  | the response status should be 500   |
      And the response status should be 200

  Rule: writing
    Scenario: no rule background here
      When I send the request body to the updateWidget operation
      Then the response status should be 200
