// template literal at char 924489..925014  body length 524  glsl-marker-hits 2
// context before: "st dT=`\nvec3 R205(vec3 c,float s){float l=dot(c,vec3(0.2126,0.7152,0.0722));return max(mix(vec3(l),c,s),0.0);}vec4 R200(sampler2D map,vec3 color,float opacity,vec2 uv){vec4 base=vec4(color,opacity);\n#ifdef Q8\nbase*=texture2D(map,uv);\n#endif\nreturn base;}\n`,h4="
// context after : ",d4=`\n#if defined(Q5) && defined(Q7)\nuniform vec4 Q147;uniform vec4 Q148;uniform float Q149;uniform mat3 Q150;vec3 R96;vec4 R90;float R87;float R92;vec3 R93(vec3 R5){float x=dot(R96,R5);float s=max(s"
// ======================================================================

#include <common>
#include <skinning_pars_vertex>
varying vec2 vUv;varying vec3 Q325;varying vec3 Q326;
#ifdef Q23
#ifndef USE_UV1
attribute vec2 uv1;
#endif
varying vec2 Q321;
#endif
void main(){vUv=uv;
#ifdef Q23
Q321=uv1;
#endif
vec3 objectNormal=vec3(normal);
#include <skinbase_vertex>
#include <skinnormal_vertex>
#include <begin_vertex>
#include <skinning_vertex>
vec4 R227=modelMatrix*vec4(transformed,1.0);Q326=R227.xyz;Q325=normalize(mat3(modelMatrix)*objectNormal);gl_Position=projectionMatrix*viewMatrix*R227;}

