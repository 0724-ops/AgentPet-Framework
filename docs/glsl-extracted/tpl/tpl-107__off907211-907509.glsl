// template literal at char 907211..907509  body length 297  glsl-marker-hits 6
// context before: "attribute vec2 uv1;\n#endif\nvarying vec2 Q321;\n#endif\nvoid main(){vUv=uv;\n#ifdef Q47\nQ321=uv1;\n#endif\n#include <skinbase_vertex>\n#include <begin_vertex>\n#include <skinning_vertex>\ngl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(transformed,1.0);}\n`,kB="
// context after : ";class ZQ{constructor(e){R(this,\"mesh\");R(this,\"material\");R(this,\"geometry\");const t=Hb+Gb;this.geometry=new Fo(2*t,2*t).rotateX(-Math.PI/2),this.material=new Bt({name:\"shadow receiver\",uniforms:{.."
// ======================================================================

uniform sampler2D Q71;uniform float Q190;uniform float Q65;varying vec2 vUv;
#ifdef Q47
uniform sampler2D Q306;varying vec2 Q321;
#endif
void main(){
#ifdef Q1
if(texture2D(Q71,vUv).a*Q190<Q65)discard;
#endif
#ifdef Q47
if(texture2D(Q306,Q321).a*Q190<Q65)discard;
#endif
gl_FragColor=vec4(1.0);}

