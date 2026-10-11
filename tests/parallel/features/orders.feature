Feature: Ordering, run by four workers at once
  Every scenario uses the same pricing stub, orders table and cache key.
  Each passes only if no other worker's scenario touches its state.

  Scenario Outline: An order is priced, saved and cached (<price>)
    Given the pricing service quotes <price> for WIDGET
    When I order 2 of WIDGET
    Then the order total is <total>
    And the pricing API at "/pricing/prices/WIDGET" was called 1 time
    And the orders table contains 1 row matching "sku = 'WIDGET' AND total = <total>"
    And the orders table contains 1 row matching "true"
    And the cached last order total is <total>

    Examples:
      | price | total |
      | 101   | 202   |
      | 102   | 204   |
      | 103   | 206   |
      | 104   | 208   |
      | 105   | 210   |
      | 106   | 212   |
      | 107   | 214   |
      | 108   | 216   |
      | 109   | 218   |
      | 110   | 220   |
      | 111   | 222   |
      | 112   | 224   |

  Scenario Outline: A promotion the test starts changes the quote (<first> then <second>)
    Given the pricing service quotes <first> for SPROCKET until the "promotion" scenario is "discounted", then <second>
    When I order 1 of SPROCKET
    Then the order total is <first>
    When the WireMock scenario "promotion" is moved to state "discounted"
    Then the WireMock scenario "promotion" is in state "discounted"
    When I order 1 of SPROCKET
    Then the order total is <second>

    Examples:
      | first | second |
      | 40    | 30     |
      | 41    | 31     |
      | 42    | 32     |
      | 43    | 33     |
      | 44    | 34     |
      | 45    | 35     |

  Scenario Outline: A repriced order uses the second quote (<first> then <second>)
    Given the pricing service quotes <first> and then <second> for GADGET
    When I order 1 of GADGET
    Then the order total is <first>
    When I order 1 of GADGET
    Then the order total is <second>
    And the pricing API at "/pricing/prices/GADGET" was called 2 times
    And the orders table contains 2 rows matching "sku = 'GADGET'"

    Examples:
      | first | second |
      | 10    | 20     |
      | 11    | 21     |
      | 12    | 22     |
      | 13    | 23     |
      | 14    | 24     |
      | 15    | 25     |
