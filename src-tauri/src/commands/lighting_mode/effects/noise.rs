//! Smooth value noise, seeded per light, so a flame or a drift keeps its own
//! course: the same seed and time give the same value, a retune does not
//! restart it, and two lights never flicker in step.

fn hash(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^ (x >> 16)
}

pub(crate) fn seed_of(parts: &[u32]) -> u32 {
    parts.iter().fold(0x9e37_79b9, |acc, &p| {
        hash(acc ^ p.wrapping_mul(0x85eb_ca6b))
    })
}

/// 0..1, fixed for `(seed, i)`.
pub(crate) fn hash01(seed: u32, i: i64) -> f32 {
    let lo = i as u32;
    let hi = (i >> 32) as u32;
    (hash(seed ^ hash(lo ^ hash(hi))) >> 8) as f32 / (1u32 << 24) as f32
}

fn smooth(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

/// 1D value noise in 0..1.
pub(crate) fn noise1(seed: u32, t: f64) -> f32 {
    let i = t.floor();
    let f = (t - i) as f32;
    let i = i as i64;
    let (a, b) = (hash01(seed, i), hash01(seed, i + 1));
    a + (b - a) * smooth(f)
}

/// Three octaves of `noise1`, still 0..1.
pub(crate) fn fbm1(seed: u32, t: f64) -> f32 {
    (0.57 * noise1(seed, t)
        + 0.29 * noise1(seed ^ 0x68e3_1da4, t * 2.13)
        + 0.14 * noise1(seed ^ 0xb529_7a4d, t * 4.37))
    .clamp(0.0, 1.0)
}

/// 2D value noise in 0..1.
pub(crate) fn noise2(seed: u32, x: f64, y: f64) -> f32 {
    let (xi, yi) = (x.floor(), y.floor());
    let (fx, fy) = (smooth((x - xi) as f32), smooth((y - yi) as f32));
    let (xi, yi) = (xi as i64, yi as i64);
    let row = |y: i64| seed ^ hash(y as u32).wrapping_add((y >> 32) as u32);
    let (r0, r1) = (row(yi), row(yi + 1));
    let top = hash01(r0, xi) + (hash01(r0, xi + 1) - hash01(r0, xi)) * fx;
    let bottom = hash01(r1, xi) + (hash01(r1, xi + 1) - hash01(r1, xi)) * fx;
    top + (bottom - top) * fy
}

pub(crate) fn fbm2(seed: u32, x: f64, y: f64) -> f32 {
    (0.6 * noise2(seed, x, y) + 0.4 * noise2(seed ^ 0x1b87_3593, x * 2.1 + 5.3, y * 2.1 + 1.7))
        .clamp(0.0, 1.0)
}
