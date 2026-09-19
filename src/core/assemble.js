/* Finite-volume assembly on an orthogonal tensor-product mesh.
 *
 * One balance equation per interior cell, 7-point stencil:
 *
 *   sum_f  mu_f (A_f / d_f) (phi_c - phi_n)  =  - sum_f (mu_f - 1) A_f  Hs_f . n_f
 *
 * where A_f is the face area, d_f the centre-to-centre distance across it, and mu_f the harmonic
 * mean of the two neighbouring cells — the series reluctance of the two half-cells, which is what
 * keeps normal B continuous across a material edge.
 *
 * Both sides are divided by a reference length, which leaves phi unchanged (the equation is
 * homogeneous of degree one in the coefficients) and keeps the numbers near unity in f32. With a
 * uniform Cartesian mesh the reference length cancels exactly and these coefficients are
 * bit-identical to the single-size formulation the tool used before grading: cX = mu_f,
 * sX = (mu_f - 1) h.
 *
 * Coordinates enter only through mesh.area and mesh.dist, so this function is the same for a
 * Cartesian box and a cylindrical annulus.
 *
 * Boundary cells get diag = 0, which is how the shaders recognise the phi = 0 Dirichlet shell.
 * A periodic axis has no boundary: its first and last cells are neighbours and both are interior.
 *
 * Lengths are converted to metres here, because Hs is in A/m and the reconstruction wants SI.
 */

const MM = 1e-3;

export function coefs(job) {
  const m = job.mesh, mu = job.mu;
  const { nx, ny, nz, N, sy, sz, periodicY } = m;

  const cX = new Float32Array(N), cY = new Float32Array(N), cZ = new Float32Array(N);
  const sX = new Float32Array(N), sY = new Float32Array(N), sZ = new Float32Array(N);
  const diag = new Float32Array(N);

  const href = m.hMin * MM;
  const hmean = (a, b) => 2 * a * b / (a + b);

  // Face area and distance factors in metres, precomputed by the mesh.
  const A = m.areaM, D = m.distM;

  for (let iz = 0; iz < nz; iz++) {
    const a0k = A[0].k[iz], a1k = A[1].k[iz], a2k = A[2].k[iz];
    const d0k = D[0].k[iz], d1k = D[1].k[iz], d2k = D[2].k[iz];
    for (let iy = 0; iy < ny; iy++) {
      const lastY = iy === ny - 1;
      const a0jk = A[0].j[iy] * a0k / href, a1jk = A[1].j[iy] * a1k / href, a2jk = A[2].j[iy] * a2k / href;
      const d0jk = D[0].j[iy] * d0k, d1jk = D[1].j[iy] * d1k, d2jk = D[2].j[iy] * d2k;
      const rowBase = (iz * ny + iy) * nx;
      // The +y neighbour of the last row is the first row when the axis wraps.
      const yStep = lastY ? sy - sz : sy;
      for (let ix = 0; ix < nx; ix++) {
        const k = rowBase + ix;

        if (ix < nx - 1) {
          const mf = hmean(mu[k], mu[k + 1]);
          const a = A[0].i[ix] * a0jk;
          cX[k] = mf * a / (D[0].i[ix] * d0jk);
          sX[k] = (mf - 1) * a;
        }
        if (!lastY || periodicY) {
          const mf = hmean(mu[k], mu[k + yStep]);
          const a = A[1].i[ix] * a1jk;
          cY[k] = mf * a / (D[1].i[ix] * d1jk);
          sY[k] = (mf - 1) * a;
        }
        if (iz < nz - 1) {
          const mf = hmean(mu[k], mu[k + sz]);
          const a = A[2].i[ix] * a2jk;
          cZ[k] = mf * a / (D[2].i[ix] * d2jk);
          sZ[k] = (mf - 1) * a;
        }
      }
    }
  }

  /* The diagonal, and with it the interior mask.
   *
   * x: the outer radial / +x and -x faces are Dirichlet. In cylindrical, ix = 0 is *not* a
   *    boundary: the r = 0 face has zero area, so it contributes nothing and needs no condition.
   * y: interior everywhere when periodic, otherwise the two ends are Dirichlet.
   * z: always Dirichlet at both ends.
   */
  const cyl = m.kind === "cylindrical";
  const ix0 = cyl ? 0 : 1;
  const iy0 = periodicY ? 0 : 1, iy1 = periodicY ? ny : ny - 1;
  for (let iz = 1; iz < nz - 1; iz++) for (let iy = iy0; iy < iy1; iy++) {
    const rowBase = (iz * ny + iy) * nx;
    const prevY = iy === 0 ? sy * (ny - 1) : -sy;   // index offset of the -y neighbour's cY entry
    for (let ix = ix0; ix < nx - 1; ix++) {
      const k = rowBase + ix;
      const inner = ix === 0 ? 0 : cX[k - 1];       // no flux through r = 0
      diag[k] = cX[k] + inner + cY[k] + cY[k + prevY] + cZ[k] + cZ[k - sz];
    }
  }
  return { cX, cY, cZ, sX, sY, sZ, diag };
}
