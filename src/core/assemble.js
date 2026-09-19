/* Finite-volume assembly: per-face permeability coefficients and the diagonal.
 *
 * One balance equation per interior cell, 7-point stencil:
 *   sum_f mu_f (phi_c - phi_n) = -h sum_f (mu_f - 1) Hs_f . n_f
 *
 * Face permeability is the harmonic mean of the two neighbouring cells, which is the series
 * resistance of the two half-cells and keeps normal B continuous across a material edge.
 * Boundary cells get diag = 0, which is how the shaders recognise the phi = 0 Dirichlet shell.
 *
 * (P1 will fold face area / face distance into these coefficients for graded meshes. On a uniform
 * grid those factors cancel to the single scalar h the shaders already carry.)
 */

export function coefs(job) {
  const { nx, ny, nz, mu } = job, N = nx * ny * nz, sy = nx, sz = nx * ny;
  const cX = new Float32Array(N), cY = new Float32Array(N), cZ = new Float32Array(N), diag = new Float32Array(N);
  const hmean = (a, b) => 2 * a * b / (a + b);
  for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const k = (iz * ny + iy) * nx + ix;
    if (ix < nx - 1) cX[k] = hmean(mu[k], mu[k + 1]);
    if (iy < ny - 1) cY[k] = hmean(mu[k], mu[k + sy]);
    if (iz < nz - 1) cZ[k] = hmean(mu[k], mu[k + sz]);
  }
  for (let iz = 1; iz < nz - 1; iz++) for (let iy = 1; iy < ny - 1; iy++) for (let ix = 1; ix < nx - 1; ix++) {
    const k = (iz * ny + iy) * nx + ix;
    diag[k] = cX[k] + cX[k - 1] + cY[k] + cY[k - sy] + cZ[k] + cZ[k - sz];
  }
  return { cX, cY, cZ, diag };
}
