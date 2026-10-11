Feature: Orders
  Scenario: Place and fetch
    When I send the request newOrder to the createOrder operation
    And I send the request empty to the getOrder operation with id from last response
    # When I send the request empty to the cancelOrder operation
    And I send the request empty to the listOrdres operation
