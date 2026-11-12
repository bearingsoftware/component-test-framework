Feature: Greeting page
  The page shows what the API answers. WireMock is the API, so the scenario
  chooses the answer.

  @ui
  Scenario: The page shows the greeting the API returns
    Given the greeting API is stubbed from wiremock/greeting
    When I navigate to the home page
    Then I should eventually see greeting containing "Hello from WireMock" on the home page
