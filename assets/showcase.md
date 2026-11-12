# A Small Observatory

A field notebook for **clear scientific writing**. This sample combines *narrative*, mathematics, structured data, and executable ideas in one editable document.

## Light, measured carefully

At dusk, the team records how a beam spreads across the detector. The signal follows $I(r)=I_0 e^{-2r^2/w^2}$, where $w$ is the beam radius. A useful report states the measurement, gives its uncertainty, and separates observation from interpretation.

> Good notes preserve what happened, including the details that did not fit the first explanation.

| Trial | Radius (mm) | Power (mW) | Observation |
| :--- | ---: | ---: | :--- |
| A | 1.20 | 4.80 | Stable baseline |
| B | 1.35 | 4.75 | Slight broadening |
| C | 1.50 | 4.71 | Repeat measurement |

These are illustrative values, not experimental results.

## Equations and uncertainty

The mean and sample standard deviation summarize repeated readings:

$$
\begin{aligned}
\bar{x} &= \frac{1}{n}\sum_{i=1}^{n}x_i, \\
s &= \sqrt{\frac{1}{n-1}\sum_{i=1}^{n}(x_i-\bar{x})^2}.
\end{aligned}
$$

For independent inputs, first-order uncertainty propagation gives

$$
\sigma_f^2 \approx \sum_{i=1}^{n}\left(\frac{\partial f}{\partial x_i}\right)^2\sigma_i^2.
$$

A two-dimensional rotation is written as

$$
R(\theta)=\begin{pmatrix}\cos\theta & -\sin\theta\\\sin\theta & \cos\theta\end{pmatrix},
\qquad \int_0^{\infty}e^{-x^2}\,dx=\frac{\sqrt{\pi}}{2}.
$$

## From notes to a reproducible method

1. Calibrate the detector before collecting data.
2. Record the ambient conditions.
   - Temperature: 21 °C
   - Exposure time: 250 ms
3. Repeat each reading and retain the raw values.

### Review checklist

- [x] Define symbols when they first appear.
- [x] Include units in table headings.
- [ ] Check the uncertainty model.
- [ ] Compare the final text with the original notes.

### A compact calculation

Use `statistics.mean` to calculate the average. Keep the raw observations separate from the derived values.

```python
from statistics import mean, stdev

power_mw = [4.80, 4.75, 4.71]
print(f"Mean: {mean(power_mw):.3f} mW")
print(f"Sample SD: {stdev(power_mw):.3f} mW")
```

### Editing without losing meaning

Replace ~~very unique~~ with **distinctive**. Prefer a concrete verb: “the beam widened” is clearer than “a widening of the beam was observed.” A short sentence can carry a precise claim; a longer one can explain its limits.

For the Markdown specification, see [CommonMark](https://commonmark.org/). A literal asterisk looks like this: \*. Chemical and mathematical notation can stay inline: $\mathrm{H_2O}$, $\alpha+\beta$, and $x\in\mathbb{R}$.

---

## Closing note

This document is an editable demonstration. Select a phrase or several paragraphs, add the selection to the conversation, and ask a focused question about wording, reasoning, or notation.
