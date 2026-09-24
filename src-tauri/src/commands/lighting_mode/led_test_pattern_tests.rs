//! The LED test pattern's reading of the transition's result.

/// The retune landed in #264 but `start_led_test_pattern` still only
/// accepted `AMBILIGHT_MODE_STARTED`, so every change after the first
/// reported "test pattern could not start" over a test that was running.
#[test]
fn a_retuned_test_is_a_success_not_a_failure() {
    assert!(
        super::led_test_pattern::is_ambilight_start_ok("AMBILIGHT_MODE_STARTED"),
        "a fresh start is a success"
    );
    assert!(
        super::led_test_pattern::is_ambilight_start_ok("AMBILIGHT_MODE_UPDATED"),
        "an in-place retune reaches the lights just as a restart does"
    );
    assert!(
        !super::led_test_pattern::is_ambilight_start_ok("AMBILIGHT_MODE_START_FAILED"),
        "a real failure must still read as one"
    );
    assert!(
        !super::led_test_pattern::is_ambilight_start_ok("DEVICE_NOT_CONNECTED"),
        "a gated start must still read as a failure"
    );
}
