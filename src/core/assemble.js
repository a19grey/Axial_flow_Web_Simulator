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
 * uniform mesh the reference length cancels exactly and these coefficients are bit-identical to
 * the single-size formulation the tool used before grading: cX = mu_f, sX = (mu_f - 1) h.
 *
 * Boundary cells get diag = 0, which is how the shaders recognise the phi = 0 Dirichlet shell.
 *
 * Lengths are converted to metres here, because Hs is in A/m and the reconstruction wants SI.
 */

const MM = 1e-3;

export function coefs(job) {
  const m = job.mesh, mu = job.mu;
  const { nx, ny, nz, N, sy, sz } = m;

  const cX = new Float32Array(N), cY = new Float32Array(N), cZ = new Float32Array(N);
  const sX = new Float32Array(N), sY = new Float32Array(N), sZ = new Float32Array(N);
  const diag = new Float32Array(N);

  // Reference length: the smallest cell, so the largest coefficient stays near unity.
  const href = m.hMin * MM;
  const hmean = (a, b) => 2 * a * b / (a + b);

  // Per-axis geometry in metres, hoisted out of the cell loop.
  const dxm = scaled(m.dx), dym = scaled(m.dy), dzm = scaled(m.dz);
  const dxf = scaled(m.dxf), dyf = scaled(m.dyf), dzf = scaled(m.dzf);

  for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) {
    const aXconst = dym[iy] * dzm[iz] / href;   // +x face area / href, independent of ix
    const rowBase = (iz * ny + iy) * nx;
    for (let ix = 0; ix < nx; ix++) {
      const k = rowBase + ix;
      if (ix < nx - 1) {
        const mf = hmean(mu[k], mu[k + 1]);
        cX[k] = mf * aXconst / dxf[ix];
        sX[k] = (mf - 1) * aXconst;
      }
      if (iy < ny - 1) {
        const mf = hmean(mu[k], mu[k + sy]), a = dxm[ix] * dzm[iz] / href;
        cY[k] = mf * a / dyf[iy];
        sY[k] = (mf - 1) * a;
      }
      if (iz < nz - 1) {
        const mf = hmean(mu[k], mu[k + sz]), a = dxm[ix] * dym[iy] / href;
        cZ[k] = mf * a / dzf[iz];
        sZ[k] = (mf - 1) * a;
      }
    }
  }

  for (let iz = 1; iz < nz - 1; iz++) for (let iy = 1; iy < ny - 1; iy++) {
    const rowBase = (iz * ny + iy) * nx;
    for (let ix = 1; ix < nx - 1; ix++) {
      const k = rowBase + ix;
      diag[k] = cX[k] + cX[k - 1] + cY[k] + cY[k - sy] + cZ[k] + cZ[k - sz];
    }
  }
  return { cX, cY, cZ, sX, sY, sZ, diag };
}

function scaled(a) {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * MM;
  return out;
}
