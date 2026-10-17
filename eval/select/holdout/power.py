"""Minimum detectable paired difference for an exact two-sided McNemar test (alpha 0.05, power 0.80), assuming a
discordance rate of 10% (p10 + p01 = 0.10). Exact: sums over the number of discordant pairs. Stdlib only."""
import math, sys

ALPHA, POWER, DISC = 0.05, 0.80, 0.10


def pmf(n, p):
    return [math.comb(n, k) * p ** k * (1 - p) ** (n - k) for k in range(n + 1)]


def reject_table(mmax):
    """For each number of discordant pairs m, the set of b with exact two-sided p <= ALPHA."""
    out = []
    for m in range(mmax + 1):
        cdf, acc = [], 0.0
        for k in range(m + 1):
            acc += math.comb(m, k) / 2 ** m
            cdf.append(acc)
        out.append([b for b in range(m + 1) if m and min(1.0, 2 * cdf[min(b, m - b)]) <= ALPHA])
    return out


def power(n, d, rej):
    q = (DISC / 2 + d / 2) / DISC  # share of discordant pairs that favour B
    pm = pmf(n, DISC)
    tot = 0.0
    for m in range(n + 1):
        if pm[m] < 1e-12 or not rej[m]:
            continue
        pb = pmf(m, q)
        tot += pm[m] * sum(pb[b] for b in rej[m])
    return tot


def mdd(n):
    rej = reject_table(n)
    for step in range(1, 201):
        d = step * 0.0005
        if d > DISC:
            break
        if power(n, d, rej) >= POWER:
            return d
    return None


def approx(n):
    """Normal approximation (Connor 1987): n = (z_a sqrt(pd) + z_b sqrt(pd - d^2))^2 / d^2, solved for d."""
    za, zb = 1.959964, 0.841621
    for step in range(1, 2001):
        d = step * 0.00005
        if d >= DISC:
            return None
        if (za * math.sqrt(DISC) + zb * math.sqrt(DISC - d * d)) ** 2 / d ** 2 <= n:
            return d
    return None


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        name, n = arg.rsplit("=", 1)
        n = int(n)
        e, a = mdd(n), approx(n)
        print("| %s | %d | %s | %s |" % (name, n, "%.1f pts" % (100 * e) if e else "> 10 pts (not detectable)", "%.1f pts" % (100 * a) if a else "> 10 pts"))
