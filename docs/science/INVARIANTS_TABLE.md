# Canon — Tabla de invariantes y criterios de aparición (sin dominios)

Esta tabla condensa los **PASS (DOMAIN)** como **invariantes/leyes operacionales** con un criterio de aparición binario (**gates**) y sin discutir dominios o narrativas. Para la evidencia audit‑ready (datasets, números, nulls exactos, intervención, hashes) ver `results/domain_passes/canon/README.md`.

Convención: un invariante “aparece” si **todas** sus gates pasan (gauge + null + bootstrap + intervención cuando aplique).

| Invariante (nombre canónico) | Observable | Objeto mínimo | Gates (todas) | Evidencia (secciones) |
|---|---|---|---|---|
| **OntoSignature espectral** | bitstring `sig∈{0,1}^m` | Matriz real `X∈ℝ^{T×D}` | `max_dH_gauge≤1`<br>`max_dH_boot≤1`<br>`dH_interv≥m//3` | `H_ONTOSIG_DOMAIN` |
| **Hiper‑relación irreducible (orden>2)** | escalar `S*` | Variables discretizables + triple entropía | `S*≥s_min` y `CI99_lo≥s_min`<br>`mean_null≤s_null_max` y `CI99_hi≤s_null_max`<br>`gauge_ok`<br>`|Δ_interv|≥0.02` | `H_HYPERREL_DOMAIN` |
| **Indicador de torsión GF(p)** | entero `T∈{0,1,2}` | Complejo 2‑skeleton inducible (V,E,F) | `T_real≥1` y `CI99_lo≥1`<br>`T_null=0` | `H_TORSION_DOMAIN` (+ controles `H_TORSION_POLLUTION_DOMAIN`, `H_TORSION_CONTROL_DOMAIN`) |
| **2‑cociclo Z₂ por composición de gauges** | tasas `violation_rate`, `nontrivial_rate` | Vistas discretas + gauges estimables por permutación | `nontrivial>0`<br>`violation≤0.20`<br>`CI99_hi(violation)≤0.25`<br>`mean_null−real≥0.20`<br>`interv mueve ≥0.05` (violation o nontrivial) | `H_COCYCLE2_DOMAIN`, `H_COCYCLE2_UNIPROT_DOMAIN`, `H_COCYCLE2_MAVEDB_PAB1_DOMAIN` |
| **Conectividad en espacio canónico (edit‑graph)** | fracción `conn_frac` | Conjunto de strings (word‑set) | `conn_frac≥min`<br>`real−max_null_mean≥sep_min`<br>`CI99_width≤max`<br>`drop_dosis≥min` y `ρ≤ρ_max`<br>`null_hierarchy_monotone` | `H_EDITGRAPH_CONN_DOMAIN` |
| **ω triádico por triple‑overlap (trigrams)** | tasa `omega_rate` | Conjunto de strings + n‑gramas | `omega_rate≥min`<br>`real−max_null_mean≥sep_min`<br>`CI99_lo≥min` y `CI99_width≤max`<br>`drop_dosis≥min` y `ρ≤ρ_max` | `H_TRIGRAM_OMEGA_DOMAIN` |
| **Connectivity can lie** | deltas `(Δconn, Δgap_ω)` | Dos invariantes medibles (conn y `gap_ω`) | `Δconn≥conn_increase_min`<br>`Δgap_ω≤−gap_drop_min` | `H_CONNECTIVITY_CAN_LIE_DOMAIN` |
| **Order beats equivalence** | deltas `(|ΔCE|,|Δgap_ω|)` | Dos pipelines con mismo multiconjunto de ops | `|ΔCE|≤ce_equiv_max`<br>`|Δgap_ω|≥gap_diff_min` | `H_ORDER_BEATS_EQUIVALENCE_DOMAIN` |
| **Ugly fix wins (cirugía dirigida)** | ω before/after | Witness extraíble + budget fijo | `ω_targeted≤omega_off_max`<br>`ω_random≥omega_off_max`<br>`(drop_targeted−drop_random)≥drop_margin_min` | `H_UGLY_FIX_WINS_DOMAIN` |
| **ExistQ (k̂ estable por evidencia)** | entero `k̂` | Features clusterizables por similitud | `mode_rate_boot≥min`<br>`mode_rate_null≤max`<br>`gauge_invariant`<br>`intervention_moves`<br>Global: `n_domains_pass≥min_domains_pass` | `H_EXISTQ_SCIENCE_DOMAIN` |
| **Betti no‑trivial (GF(2))** | entero `b*=b1+b2` | Complejo 2‑skeleton inducible | Per‑dataset: `b*≥1` + null colapsa a 0<br>Global: `null_zero_rate≥min` + `n_domains_pass≥min_domains_pass` | `H_BETTI_SCIENCE_DOMAIN` |
| **Aditividad parcial (DMS)** | `ρ=|Spearman(y_k2, s1+s2)|` | Variantes + referencia + singles (k=1) y dobles (k=2) | `ρ_k2≥rho_k2_min`<br>`mean_null≤rho_null_mean_max`<br>`CI99_lo≥rho_boot_ci99_lo_min`<br>`(ρ_k1_gate−ρ_k2)≥intervention_drop_min` | `H_ADDITIVITY_MAVEDB_PAB1_DOMAIN`, `H_ADDITIVITY_MAVEDB_BRCA1_E3_DOMAIN`, `H_ADDITIVITY_MAVEDB_GFP_NT_DOMAIN`, `H_ADDITIVITY_MAVEDB_PDZ3_DOMAIN` |
| **Epistasis global monotónica (isotonic)** | `gain=R²_iso−R²_lin` | Como arriba (DMS k=1/k=2) | `gain≥gain_k2_min`<br>`mean_null≤null_gain_mean_max`<br>`CI99_lo≥gain_boot_ci99_lo_min`<br>`Δgain_interv≥intervention_gain_delta_min`<br>`gauge_mean_gain≥gain_k2_min` | `H_GLOBAL_EPISOTONIC_MAVEDB_PAB1_DOMAIN`, `H_GLOBAL_EPISOTONIC_MAVEDB_GFP_AA_DOMAIN`, `H_GLOBAL_EPISOTONIC_MAVEDB_GFP_NT_DOMAIN` |
| **Cierre triádico en red de epistasis fuerte** | `ratio=T_real/mean(T_null)` + witness | DMS k=2 + single map k=1 | `ratio≥2` y `T_real>max(T_null)`<br>`mean_gauge_ratio≥2`<br>`CI99_lo(ratio)≥2`<br>`surgery drop≥30%`<br>`p(rand≤targeted)≤0.05` | `H_TRIADIC_CLOSURE_MAVEDB_PAB1_DOMAIN`, `H_TRIADIC_CLOSURE_MAVEDB_GFP_AA_DOMAIN`, `H_TRIADIC_CLOSURE_MAVEDB_GFP_NT_DOMAIN`, `H_TRIADIC_CLOSURE_MAVEDB_PDZ3_DOMAIN` |

Notas:
- Los umbrales numéricos exactos y los valores “hoy” (real/null/bootstrap/intervención) están en `results/domain_passes/canon/README.md` junto con `*_results.json` y `FREEZE_MANIFEST.json`.
- Esta tabla **no afirma universalidad**: es una **compresión** de lo que hoy está PASS en modo DOMAIN bajo gates fijos. Para extender, el siguiente paso correcto es cross‑domain con el mismo gate‑set (sin tocar thresholds).
