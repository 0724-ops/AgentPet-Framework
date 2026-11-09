// template literal at char 906854..907206  body length 351  glsl-marker-hits 2
// context before: ".alphaTest>0&&s.map&&(e.Q1=\"\"),new Bt({name:`${s.mesh.name} (shadow caster)`,defines:e,uniforms:{Q71:{value:s.map},Q306:{value:s.uv1Alpha??null},Q190:{value:s.opacity},Q65:{value:s.alphaTest}},vertexShader:FB,fragmentShader:kB,side:Sn,colorWrite:!1})}const FB="
// context after : ",kB=`\nuniform sampler2D Q71;uniform float Q190;uniform float Q65;varying vec2 vUv;\n#ifdef Q47\nuniform sampler2D Q306;varying vec2 Q321;\n#endif\nvoid main(){\n#ifdef Q1\nif(texture2D(Q71,vUv).a*Q190<Q65)"
// ======================================================================

#include <common>
#include <skinning_pars_vertex>
varying vec2 vUv;
#ifdef Q47
#ifndef USE_UV1
attribute vec2 uv1;
#endif
varying vec2 Q321;
#endif
void main(){vUv=uv;
#ifdef Q47
Q321=uv1;
#endif
#include <skinbase_vertex>
#include <begin_vertex>
#include <skinning_vertex>
gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(transformed,1.0);}

