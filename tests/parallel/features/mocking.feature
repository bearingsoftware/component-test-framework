Feature: The stub builder and GraphQL steps, run by four workers at once (COMPONENT-23)
  Every scenario stubs the same paths, so each passes only if no other
  worker's stubs answer it.

  Scenario Outline: A builder stub prices an order, and a GraphQL stub answers a token call (<price>)
    Given a builder stub quotes <price> for BUILDER
    And the octopus GraphQL mutation obtainKrakenToken returns:
      """
      {"obtainKrakenToken": {"token": "token-<price>"}}
      """
    When I order 1 of BUILDER
    Then the order total is <price>
    When a client obtains a Kraken token with no operationName
    Then the Kraken token is "token-<price>"
    And the octopus GraphQL mutation obtainKrakenToken was called 1 time
    And the octopus GraphQL query obtainKrakenToken was called 0 times

    Examples:
      | price |
      | 61    |
      | 62    |
      | 63    |
      | 64    |

  Scenario: GraphQL errors and variables
    Given the octopus GraphQL query account returns the errors:
      """
      [{"message": "not found", "extensions": {"code": "NOT_FOUND"}}]
      """
    And the octopus GraphQL query account with variables "{\"accountNumber\": \"A-1\"}" returns:
      """
      {"account": {"number": "A-1"}}
      """
    When a client queries the account "A-1"
    Then the GraphQL response data is {"account":{"number":"A-1"}}
    When a client queries the account "A-2"
    Then the GraphQL response error code is "NOT_FOUND"
