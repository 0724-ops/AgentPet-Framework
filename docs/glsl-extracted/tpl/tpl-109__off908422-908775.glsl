// template literal at char 908422..908775  body length 352  glsl-marker-hits 5
// context before: "oveFromParent(),this.geometry.dispose(),this.material.dispose()}}const BB=.032,Hb=.3,Gb=2.5,zB=[.4452,.4452,.4452],QB=`\nvarying vec3 Q326;void main(){vec4 world=modelMatrix*vec4(position,1.0);Q326=world.xyz;gl_Position=projectionMatrix*viewMatrix*world;}\n`,VB="
// context after : ";function HB(){return{Q97:{value:0},Q92:{value:new C},Q98:{value:0},Q96:{value:0},Q94:{value:null},Q95:{value:new ze(1,1,0,0)},Q99:{value:1},Q93:{value:0},Q91:{value:new ce}}}const cT=`\nuniform float"
// ======================================================================

uniform vec3 Q85;uniform vec2 Q133;uniform vec4 Q261;varying vec3 Q326;
${aT}
void main(){float t=clamp((Q133.x+Q133.y-distance(Q326,Q85))/Q133.y,0.0,1.0);float R77=t*t*(3.0-2.0*t);if(R77<=0.0)discard;float v=clamp(0.95-R57(Q326,vec3(0.0,1.0,0.0)),0.0,1.0)*Q261.a*R77;gl_FragColor=vec4(mix(vec3(1.0),Q261.rgb,v),1.0);
#include <colorspace_fragment>
}

