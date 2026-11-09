// template literal at char 1110611..1110658  body length 46  glsl-marker-hits 0
// context before: "floats)==null?void 0:u._SDFSwitchEnd)??14.1)},Q280:s.userData.stageFactor};s.onBeforeCompile=h=>{Object.assign(h.uniforms,r),h.vertexShader=h.vertexShader.replace(\"#include <common>\",`#include <common>\nvarying float Q319;`).replace(\"#include <project_vertex>\","
// context after : ");const d=e?`\n{vec2 R214=vec2(vMapUv.x,1.0-vMapUv.y)*Q258.xy+Q258.zw;vec4 s=texture2D(Q255,vec2(R214.x,1.0-R214.y));float e=0.5-s.r;float R83=max(length(vec2(dFdx(e),dFdy(e))),1e-6);float k=clamp((ab"
// ======================================================================
#include <project_vertex>
Q319= -mvPosition.z;
