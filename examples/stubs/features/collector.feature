Feature: Capture stubs
  A service that forwards events is tested against stubs that record what it sends.

  Scenario: The collector accepts an event
    When the service posts "login" to the collector
    Then the collector stub saw 1 request matching "path=/events; method=POST; body~login"
    And the service saw status 200

  Scenario: The collector rejects the first event only
    Given the collector stub answers 503 once for requests matching "path=/events"
    When the service posts "a" to the collector
    And the service posts "b" to the collector
    Then the collector stub saw 2 requests matching "path=/events"
    And the service saw status 200

  Scenario: The collector is down
    Given the collector stub is down
    And the collector stub is up
    When the service posts "back" to the collector
    Then the service saw status 200

  Scenario: A syslog line arrives
    When the service logs "<14>started" to syslog
    Then I wait for the syslog stub to see 1 request matching "body~started"
