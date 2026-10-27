//! Projective geometry helpers: 4-point homographies and 3x3 inversion.

pub type M3 = [[f64; 3]; 3];
pub type P = (f64, f64);

/// Homography mapping `src[i]` -> `dst[i]` (h33 fixed to 1).
pub fn homography(src: [P; 4], dst: [P; 4]) -> Option<M3> {
    let mut a = [[0f64; 9]; 8];
    for i in 0..4 {
        let (x, y) = src[i];
        let (u, v) = dst[i];
        a[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -x * u, -y * u, u];
        a[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -x * v, -y * v, v];
    }
    for c in 0..8 {
        let p = (c..8).max_by(|&i, &j| a[i][c].abs().total_cmp(&a[j][c].abs()))?;
        if a[p][c].abs() < 1e-12 {
            return None;
        }
        a.swap(c, p);
        for r in 0..8 {
            if r != c {
                let f = a[r][c] / a[c][c];
                for k in c..9 {
                    a[r][k] -= f * a[c][k];
                }
            }
        }
    }
    let h: Vec<f64> = (0..8).map(|i| a[i][8] / a[i][i]).collect();
    Some([[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1.0]])
}

pub fn invert(m: &M3) -> Option<M3> {
    let c = |r1: usize, c1: usize, r2: usize, c2: usize| m[r1][c1] * m[r2][c2] - m[r1][c2] * m[r2][c1];
    let det = m[0][0] * c(1, 1, 2, 2) - m[0][1] * c(1, 0, 2, 2) + m[0][2] * c(1, 0, 2, 1);
    if det.abs() < 1e-14 {
        return None;
    }
    let d = 1.0 / det;
    Some([
        [c(1, 1, 2, 2) * d, -c(0, 1, 2, 2) * d, c(0, 1, 1, 2) * d],
        [-c(1, 0, 2, 2) * d, c(0, 0, 2, 2) * d, -c(0, 0, 1, 2) * d],
        [c(1, 0, 2, 1) * d, -c(0, 0, 2, 1) * d, c(0, 0, 1, 1) * d],
    ])
}

/// Applies `m` to a point; returns `None` when the point is behind the projection plane.
pub fn apply(m: &M3, (x, y): P) -> Option<P> {
    let w = m[2][0] * x + m[2][1] * y + m[2][2];
    if w <= 1e-9 {
        return None;
    }
    Some((
        (m[0][0] * x + m[0][1] * y + m[0][2]) / w,
        (m[1][0] * x + m[1][1] * y + m[1][2]) / w,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corners_round_trip() {
        let src = [(0.0, 0.0), (100.0, 0.0), (100.0, 200.0), (0.0, 200.0)];
        let dst = [(10.0, 5.0), (90.0, 20.0), (95.0, 180.0), (5.0, 170.0)];
        let h = homography(src, dst).unwrap();
        let inv = invert(&h).unwrap();
        for i in 0..4 {
            let p = apply(&h, src[i]).unwrap();
            assert!((p.0 - dst[i].0).abs() < 1e-6 && (p.1 - dst[i].1).abs() < 1e-6);
            let q = apply(&inv, dst[i]).unwrap();
            assert!((q.0 - src[i].0).abs() < 1e-6 && (q.1 - src[i].1).abs() < 1e-6);
        }
    }

    #[test]
    fn degenerate_rejected() {
        let src = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)];
        let dst = [(0.0, 0.0); 4];
        assert!(homography(src, dst).is_none());
    }
}
