import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { HomePage } from './pages/HomePage.js';
import { MeetingPage } from './pages/MeetingPage.js';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/meeting/:id" element={<MeetingPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
