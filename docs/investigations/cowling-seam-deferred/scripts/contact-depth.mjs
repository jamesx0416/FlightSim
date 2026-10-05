(async () => {
  const api = window.__DevApi
  api.camera.setPose({position: [-20.28498574810446, 23.69840952508541, 11.568727641111206], quaternion: [0.13671903433611007, -0.49047646723309873, 0.07823766838095476, 0.8570995321355931], target: [-9.223340300884592, 27.898409525085405, 5.068727641111212]})
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  return {stage: api.status().data.loadStage, status: api.rendering.contactOcclusionStatus(), depth: await window.__contactDepthProbe([-10.904923993062894, 26.90211064965465, 7.117734054207994])}
})()
