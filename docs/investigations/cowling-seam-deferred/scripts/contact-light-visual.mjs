(async () => {
 const api=window.__DevApi;
 const key=window.__lastScene.children.filter(o=>o.isDirectionalLight)[0];
 const target=key.target.getWorldPosition(key.position.clone());
 const original=key.position.clone();
 const direction=original.clone().sub(target);
 const axis=original.clone().set(0,1,0);
 const wait=count=>new Promise(resolve=>{const next=()=>count--<=0?resolve():requestAnimationFrame(next);requestAnimationFrame(next)});
 const captures=[];
 try { for (const angle of [0,30,0]) {key.position.copy(target).add(direction.clone().applyAxisAngle(axis,angle*Math.PI/180));key.updateWorldMatrix(true,false);await wait(90);captures.push({angle,pose:api.camera.getPose(),shadows:api.rendering.inspectShadows().data.enabled,shot:await api.screenshot({target:'viewport'})})} }
 finally {key.position.copy(original);key.updateWorldMatrix(true,false)}
 return captures;
})()
