(async()=>{
 const api=window.__DevApi;
 const key=window.__lastScene.children.filter(o=>o.isDirectionalLight)[0];
 const original=key.position.clone();const target=key.target.getWorldPosition(original.clone());const direction=original.clone().sub(target);const axis=original.clone().set(0,1,0);
 const previousPose=api.camera.getPose().data;
 const wait=count=>new Promise(resolve=>{const next=()=>count--<=0?resolve():requestAnimationFrame(next);requestAnimationFrame(next)});
 const center=[-9.223340300884592,27.898409525085405,5.068727641111212];
 const poses=[
  {name:'near',position:[-20.28498574810446,23.69840952508541,11.568727641111206],quaternion:[0.13671903433611007,-0.49047646723309873,0.07823766838095476,0.8570995321355931],target:center},
  {name:'distant',position:[-31.346631195324328,19.498409525085414,18.0687276411112],quaternion:[0.13671903433611007,-0.49047646723309873,0.07823766838095476,0.8570995321355931],target:center},
  {name:'oblique',position:[-18.367190693361493,23.698409525085403,-3.931272358888788],quaternion:[-0.06085753970587107,0.910840102978718,-0.14529138640826267,-0.3815194355497916],target:center}
 ];
 const results=[];
 try {for(const pose of poses){api.camera.setPose(pose);for(const angle of [0,28]){key.position.copy(target).add(direction.clone().applyAxisAngle(axis,angle*Math.PI/180));key.updateWorldMatrix(true,false);await wait(90);results.push({view:pose.name,angle,shadows:api.rendering.inspectShadows().data.enabled,perf:api.perf().data.gpuTimestamp,shot:await api.screenshot({target:'viewport'})})}}}
 finally{key.position.copy(original);key.updateWorldMatrix(true,false);api.camera.setPose(previousPose)}
 return results;
})()
