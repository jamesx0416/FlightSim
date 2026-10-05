(async () => {
  const api = window.__DevApi;
  const key = window.__lastScene.children.filter(o => o.isDirectionalLight)[0];
  const target = key.target.getWorldPosition(key.position.clone());
  const original = key.position.clone();
  const direction = original.clone().sub(target);
  const axis = key.position.clone().set(0,1,0);
  const wait = count => new Promise(resolve => { const next=()=>count--<=0?resolve():requestAnimationFrame(next); requestAnimationFrame(next); });
  const results=[];
  try {
    for (const angle of [0,15,-15,30,-30,0]) {
      key.position.copy(target).add(direction.clone().applyAxisAngle(axis,angle*Math.PI/180));
      key.updateWorldMatrix(true,false);
      await wait(60);
      const s=await api.screenshot({target:'viewport'});
      const bitmap=await createImageBitmap(await(await fetch(s.data.dataUrl)).blob());
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);
      const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);
      const pixel=[...ctx.getImageData(703,300,1,1).data];
      bitmap.close();
      results.push({angle,pixel,light: key.position.toArray(),shadows:api.rendering.inspectShadows().data.enabled,gpu:api.perf().data.gpuTimestamp.latestMs});
    }
  } finally { key.position.copy(original);key.updateWorldMatrix(true,false); }
  return results;
})()
