// template literal at char 908280..908417  body length 136  glsl-marker-hits 2
// context before: "ulled=!1}setCentre(e){this.mesh.position.set(e.x,e.y+BB,e.z),this.material.uniforms.Q85.value.copy(this.mesh.position)}dispose(){this.mesh.removeFromParent(),this.geometry.dispose(),this.material.dispose()}}const BB=.032,Hb=.3,Gb=2.5,zB=[.4452,.4452,.4452],QB="
// context after : ",VB=`\nuniform vec3 Q85;uniform vec2 Q133;uniform vec4 Q261;varying vec3 Q326;\n${aT}\nvoid main(){float t=clamp((Q133.x+Q133.y-distance(Q326,Q85))/Q133.y,0.0,1.0);float R77=t*t*(3.0-2.0*t);if(R77<=0.0)"
// ======================================================================

varying vec3 Q326;void main(){vec4 world=modelMatrix*vec4(position,1.0);Q326=world.xyz;gl_Position=projectionMatrix*viewMatrix*world;}

