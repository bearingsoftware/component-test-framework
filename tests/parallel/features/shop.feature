@ui
Feature: The shop SPA, one server per worker
  Scenario Outline: The shop shows this worker's price (<price>)
    Given the pricing service quotes <price> for WIDGET
    When I open the shop
    Then the shop shows the widget price <price>
    And the shop was served by this worker

    Examples:
      | price |
      | 301   |
      | 302   |
      | 303   |
      | 304   |
      | 305   |
      | 306   |
      | 307   |
      | 308   |
