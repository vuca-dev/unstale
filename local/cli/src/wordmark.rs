//! Shared Menlo Bold geometry and proportional, reserved repair deliveries.
use super::{hash, smooth};
use std::collections::{BTreeSet, HashMap};
use std::sync::OnceLock;

pub const REPAIR_CAPACITY: f64 = 1.;
#[derive(serde::Deserialize)]
struct Geometry {
    points: Vec<(usize, usize)>,
}
#[derive(Debug)]
pub struct Repair {
    pub birth: f64,
    pub landing: f64,
    pub duration: f64,
    pub seed: usize,
    pub destination: (usize, usize),
    pub claims: Vec<(usize, f64)>,
}
pub struct Plan {
    pub letters: Vec<(usize, usize)>,
    pub repairs: Vec<Repair>,
}

pub fn plan(width: usize, height: usize) -> &'static Plan {
    static NORMAL: OnceLock<Plan> = OnceLock::new();
    static COMPACT: OnceLock<Plan> = OnceLock::new();
    let cache = if width == 128 { &NORMAL } else { &COMPACT };
    cache.get_or_init(|| {
        let geometry: Geometry =
            serde_json::from_str(include_str!("../../../docs/assets/wordmark.json"))
                .expect("checked-in wordmark geometry");
        let letters = geometry
            .points
            .into_iter()
            .map(|(x, y)| (x * width / 256, y * height / 80))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let repairs = plan_repairs(&letters, width, height);
        Plan { letters, repairs }
    })
}

fn plan_repairs(letters: &[(usize, usize)], width: usize, height: usize) -> Vec<Repair> {
    let mut reserved_until = vec![0f64; letters.len()];
    let mut repairs = vec![];
    if letters.is_empty() {
        return repairs;
    }
    for event in 0..9 {
        let birth = 6.2 + event as f64 * 2.2 + hash(event + 701) * 0.5;
        let target = letters[(hash(event + 101) * letters.len() as f64) as usize];
        // Keep insertion order, matching the website's Map and particle seeds.
        let mut regions: Vec<Vec<(usize, f64)>> = vec![];
        let mut slots = HashMap::new();
        for (index, &(x, y)) in letters.iter().enumerate() {
            if reserved_until[index] > birth
                || hash(index + event * 911) > 0.78 + hash(event + 401) * 0.22
            {
                continue;
            }
            let radius = ((x as f64 - target.0 as f64)
                / (width as f64 * (0.05 + hash(event + 201) * 0.1)))
                .powi(2)
                + ((y as f64 - target.1 as f64)
                    / (height as f64 * (0.11 + hash(event + 301) * 0.22)))
                    .powi(2);
            let amount = 1. - smooth((radius - 0.3) / 1.1);
            if amount <= 0. {
                continue;
            }
            let key = x / 6 + (y / 6) * width.div_ceil(6);
            let slot = *slots.entry(key).or_insert_with(|| {
                regions.push(vec![]);
                regions.len() - 1
            });
            regions[slot].push((index, amount));
        }
        for members in regions {
            let total: f64 = members.iter().map(|(_, amount)| amount).sum();
            let count = (total / REPAIR_CAPACITY).ceil() as usize;
            let mut loads = vec![vec![]; count];
            let mut mass = 0f64;
            for (index, amount) in members {
                let mut remaining = amount;
                while remaining > 1e-10 {
                    let slot = ((mass / REPAIR_CAPACITY).floor() as usize).min(count - 1);
                    let amount = remaining.min((slot + 1) as f64 * REPAIR_CAPACITY - mass);
                    if amount <= 1e-10 {
                        mass = (slot + 1) as f64 * REPAIR_CAPACITY;
                        continue;
                    }
                    loads[slot].push((index, amount));
                    mass += amount;
                    remaining -= amount;
                }
            }
            for claims in loads {
                if claims.is_empty() {
                    continue;
                }
                let seed = repairs.len() + event * 1999;
                let duration = 1.2 + hash(seed + 3101) * 0.8;
                let landing = birth + 0.7 + duration + hash(seed + 3001) * 2.;
                let destination = letters[claims[claims.len() / 2].0];
                for &(index, _) in &claims {
                    reserved_until[index] = reserved_until[index].max(landing);
                }
                repairs.push(Repair {
                    birth,
                    landing,
                    duration,
                    seed,
                    destination,
                    claims,
                });
            }
        }
    }
    repairs
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repairs_reserve_each_stale_amount_once_and_carry_at_most_one_dot() {
        for (width, height) in [(128, 40), (88, 28)] {
            let plan = plan(width, height);
            assert!(!plan.letters.is_empty() && !plan.repairs.is_empty());
            let mut reservations: HashMap<usize, Vec<(f64, f64, f64)>> = HashMap::new();
            let mut regions: HashMap<(u64, usize, usize), (f64, usize)> = HashMap::new();
            for repair in &plan.repairs {
                let mass: f64 = repair.claims.iter().map(|(_, amount)| amount).sum();
                assert!(mass > 0. && mass <= REPAIR_CAPACITY + 1e-9);
                assert!(repair.landing - repair.duration > repair.birth + 0.65);
                assert!(repair.landing < 31.);
                let region = regions
                    .entry((
                        repair.birth.to_bits(),
                        repair.destination.0 / 6,
                        repair.destination.1 / 6,
                    ))
                    .or_default();
                region.0 += mass;
                region.1 += 1;
                for &(index, amount) in &repair.claims {
                    assert_eq!(
                        (plan.letters[index].0 / 6, plan.letters[index].1 / 6),
                        (repair.destination.0 / 6, repair.destination.1 / 6)
                    );
                    let previous = reservations.entry(index).or_default();
                    for &(birth, landing, _) in previous.iter() {
                        assert!(birth == repair.birth || landing <= repair.birth);
                    }
                    previous.push((repair.birth, repair.landing, amount));
                    let reserved: f64 = previous
                        .iter()
                        .filter(|(birth, _, _)| *birth == repair.birth)
                        .map(|(_, _, amount)| amount)
                        .sum();
                    assert!(reserved <= 1. + 1e-9);
                }
            }
            for (mass, count) in regions.values() {
                assert_eq!(*count, ((mass - 1e-9) / REPAIR_CAPACITY).ceil() as usize);
            }
        }
    }
}
