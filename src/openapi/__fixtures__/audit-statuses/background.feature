@widgets
Feature: Widgets
  Description lines are not steps.
  Then the response status should be 999

  Background:
    Given I send the request empty to the ping operation
    Then the response status should be 200

  # When I send the request x to the createWidget operation
  Scenario: create
    When I send the request newWidget to the createWidget operation
    Then the response status should be 201

  @invalid
  Scenario Outline: create invalid
    When I send the request <body> to the <operation> operation
    Then the response status should be <status>

    Examples:
      | body  | operation    | status |
      | bad   | createWidget | 400    |
      | worse | createWidget | 422    |
