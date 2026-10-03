#include <zdsp/analysis/crepe_tiny.h>
#include <zdsp/analysis/pitch_analysis_module.h>
#include <zcore/audio/capture_recording.h>
#include <array>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
int main(int argc,char**argv){
 if(argc!=4)return 2;
 try {
  zdsp::analysis::CrepeTiny model(argv[1]);
  std::ifstream fixtures(argv[2],std::ios::binary);
  if(!fixtures)return 3;
  std::array<float,1024> input{};std::array<float,360> expected{};int count=0;
  while(fixtures.read(reinterpret_cast<char*>(input.data()),sizeof(input))){
   if(!fixtures.read(reinterpret_cast<char*>(expected.data()),sizeof(expected)))return 4;
   auto frame=model.analyze(input.data(),1024,16000);
   if(frame.frequency<=0 || frame.peak<=0 || frame.peak<frame.rms)return 5;
   for(size_t i=0;i<360;++i)if(std::abs(model.probabilities()[i]-expected[i])>1e-4f)return 6;
   ++count;
  }
  if(count!=6)return 7;
  zdsp::analysis::PitchAnalysisModule graph({zdsp::analysis::PitchDetectorKind::CrepeTiny, argv[1], 9});
  int graphFrames=0;
  for(int i=0;i<30;++i){
   std::array<float,320> tone{};
   for(size_t j=0;j<tone.size();++j)tone[j]=.25f*std::sin(2*3.141592653589793*440*(i*320+j)/16000);
   singz::AudioInputBlockView capture{};
   capture.mono=tone.data();capture.frames=320;capture.sampleRate=16000;
   capture.capture.clockDomainId=42;capture.capture.streamGeneration=9;
   capture.capture.sequence=i+1;capture.capture.sourceFrame=i*320;
   capture.capture.sampleHostTimeNs=1000000000ull+i*20000000ull;
   capture.capture.flags=singz::AudioInputSourceFrameValid|singz::AudioInputSampleHostTimeValid|singz::AudioInputTimestampQualityValid;
   capture.capture.timestampQuality=singz::AudioInputTimestampQuality::Hardware;
   if(!graph.push(capture,[&](const auto& frame){
     if(frame.analysis.frequency>0){
       if(std::abs(1200*std::log2(frame.analysis.frequency/440))>5)throw std::runtime_error("Graph CREPE tone mismatch");
       if(frame.start.quality!=zdsp::CaptureTimestampQuality::Hardware)throw std::runtime_error("Graph timestamp mismatch");
       ++graphFrames;
     }
   }))return 14;
  }
  if(graphFrames<20)return 15;
  input.fill(0);if(model.analyze(input.data(),1024,16000).frequency!=0)return 8;
  bool rejected=false;try{model.analyze(input.data(),1023,16000);}catch(...){rejected=true;}if(!rejected)return 9;
  singz::CaptureRecording take;take.filename="SingZ-microphone-test.wav";
  if(!singz::CaptureRecording::validName(take.filename)||singz::CaptureRecording::validName("../bad.wav"))return 10;
  input.fill(.25f);singz::AudioInputBlockView block{};block.mono=input.data();block.frames=1024;block.sampleRate=24000;
  for(int i=0;i<800;++i)take.append(block);
  if(take.pcm.size()!=720000)return 11;
  if(take.save(argv[3])!=30)return 12;
  std::ifstream wav(argv[3],std::ios::binary|std::ios::ate);if(wav.tellg()!=1440044)return 13;
  wav.close();std::remove(argv[3]);std::cout<<"CREPE probability parity and bounded WAV recording passed\n";
 }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
