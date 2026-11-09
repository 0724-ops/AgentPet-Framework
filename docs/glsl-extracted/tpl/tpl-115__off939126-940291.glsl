// template literal at char 939126..940291  body length 1164  glsl-marker-hits 9
// context before: "7\ncolor+=R145(N,V)*Q199*base.a*mix(1.0,base.a,Q66);\n#endif\n#endif\ncolor+=R226*Q91*mix(1.0,base.a,Q66);\n#ifdef Q27\ngl_FragColor=vec4(color,base.a);\n#else\ngl_FragColor=vec4(color,1.0);\n#endif\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}\n`,m4="
// context after : ",g4=`\n#include <common>\nuniform sampler2D Q71;uniform vec3 Q69;uniform float Q190;uniform float Q65;uniform float Q191;uniform float Q195;uniform vec3 Q196;varying vec2 vUv;varying vec3 Q326;\n${dT}\n$"
// ======================================================================

#include <common>
#include <skinning_pars_vertex>
uniform float Q197;uniform float Q194;uniform vec2 Q192;uniform sampler2D Q193;
#ifdef Q26
attribute vec3 Q57;
#endif
varying vec2 vUv;varying vec3 Q326;void main(){vUv=uv;
#ifdef Q26
vec3 objectNormal=Q57;
#else
vec3 objectNormal=normal;
#endif
#include <skinbase_vertex>
#include <skinnormal_vertex>
#include <begin_vertex>
#include <skinning_vertex>
Q326=(modelMatrix*vec4(transformed,1.0)).xyz;vec4 mvPosition=modelViewMatrix*vec4(transformed,1.0);gl_Position=projectionMatrix*mvPosition;vec3 n=normalize(normalMatrix*objectNormal);vec2 R140=(projectionMatrix*vec4(n,0.0)).xy;R140*=inversesqrt(max(dot(R140,R140),1e-12));R140.x*=Q192.y/Q192.x;float R104=atan(1.0/projectionMatrix[1][1]);float w=gl_Position.w;vec2 R142=R140*(0.392699/R104*Q197*clamp(w*R104*4.583663,0.0,1.0)*0.005);vec2 R151=min(max(w,0.0),1.570796/R104)/Q192;R142=mix(R142,sign(R142)*R151,vec2(lessThan(abs(R142),R151)));float R137=Q194;
#ifdef Q15
vec2 R141=texture2D(Q193,uv).rg;R142*=R141.r;R137*=R141.g;
#endif
gl_Position.xy+=R142;vec4 R152=projectionMatrix*vec4(mvPosition.xy,mvPosition.z-0.1*R137,1.0);gl_Position.z=R152.z*w/R152.w;}

