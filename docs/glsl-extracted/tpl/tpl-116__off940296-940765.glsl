// template literal at char 940296..940765  body length 468  glsl-marker-hits 10
// context before: "51,vec2(lessThan(abs(R142),R151)));float R137=Q194;\n#ifdef Q15\nvec2 R141=texture2D(Q193,uv).rg;R142*=R141.r;R137*=R141.g;\n#endif\ngl_Position.xy+=R142;vec4 R152=projectionMatrix*vec4(mvPosition.xy,mvPosition.z-0.1*R137,1.0);gl_Position.z=R152.z*w/R152.w;}\n`,g4="
// context after : ",Mx=new jn(new Uint8Array([255,255,255,255]),1,1);Mx.needsUpdate=!0;const er={Q251:{value:Mx},Q252:{value:0}},tr={frame:0,drawnAt:-10,requested:!1};function v4(){tr.requested=!0}function x4(){tr.draw"
// ======================================================================

#include <common>
uniform sampler2D Q71;uniform vec3 Q69;uniform float Q190;uniform float Q65;uniform float Q191;uniform float Q195;uniform vec3 Q196;varying vec2 vUv;varying vec3 Q326;
${dT}
${cT}
void main(){vec4 base=R200(Q71,Q69,Q190,vUv);
#ifdef Q1
if(base.a<Q65)discard;
#endif
R223(Q326,vUv);
#ifdef Q16
gl_FragColor=vec4(Q196,1.0);
#else
gl_FragColor=vec4(R205(base.rgb,Q195)*Q191,1.0);
#endif
#include <tonemapping_fragment>
#include <colorspace_fragment>
}

